#!/usr/bin/env node
/**
 * Standalone demo: boots the real MCP HTTP server outside VS Code and drives it
 * with the real MCP SDK client over HTTP.
 *
 * Why this works: the server's only hard VS Code dependency is the `vscode`
 * module (imported by dapBridge.ts). We bundle httpTransport.ts with esbuild,
 * externalize `vscode`, and provide a tiny stub that exposes a fake debug
 * session speaking real DAP. Everything else — HTTP transport, MCP protocol,
 * port file discovery — is the production code path.
 *
 * Usage: node scripts/standalone-demo.js
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// 1. Build the server bundle (httpTransport.ts → CJS, vscode externalized)
//    into a per-invocation private dir (fixed /tmp names are a tamper/race
//    hazard and linger; this dir is removed on exit).
// ---------------------------------------------------------------------------
const esbuild = require('esbuild');
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdebug-mcp-demo-'));
const bundlePath = path.join(bundleDir, 'standalone-bundle.cjs');
const cleanup = () => fs.rmSync(bundleDir, { recursive: true, force: true });
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Refuse to clobber a live extension instance's discovery file: startHttpServer
// unconditionally rewrites ~/.vscode-xdebug-mcp/port.json and stopHttpServer
// deletes it, so running the demo while a real instance owns it would silently
// redirect and then destroy the extension's discovery entry.
const portFile = path.join(os.homedir(), '.vscode-xdebug-mcp', 'port.json');
if (fs.existsSync(portFile)) {
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(portFile, 'utf8')); } catch { /* stale/garbage file — proceed */ }
  const pidAlive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code !== 'ESRCH'; } // EPERM = exists but not ours; ESRCH = gone
  };
  if (owner && typeof owner.pid === 'number' && owner.pid !== process.pid && pidAlive(owner.pid)) {
    console.error(`\nRefusing to run: ${portFile} is owned by live pid ${owner.pid} (a running extension instance?).`);
    console.error('Close the extension host (or delete the file) before running the demo.');
    cleanup();
    process.exit(1);
  }
}

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'demo-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['vscode'],
  logLevel: 'silent',
});

// ---------------------------------------------------------------------------
// 2. Fake debug session — real DAP responses (mirrors the mock adapter fixture)
// ---------------------------------------------------------------------------
const fakeWorkspacePath = '/home/user/test-workspace';

const fakeSession = {
  id: 'demo-session-1',
  name: 'PHP (Xdebug) demo',
  type: 'php',
  configuration: { name: 'Listen for Xdebug', type: 'php' },
  workspaceFolder: { uri: { fsPath: fakeWorkspacePath }, name: 'test-workspace', index: 0 },
  state: 1, // DebugState.Active (1 = Active, 0 = Inactive, 2 = Terminated)
  async customRequest(command, args = {}) {
    switch (command) {
      case 'threads':
        return { threads: [{ id: 1, name: 'Main Thread' }] };
      case 'stackTrace':
        return {
          stackFrames: [
            { id: 0, name: 'index.php:10', source: { name: 'index.php', path: `${fakeWorkspacePath}/index.php` }, line: 10, column: 1 },
            { id: 1, name: 'helper', source: { name: 'helper.php', path: `${fakeWorkspacePath}/helper.php` }, line: 5, column: 1 },
            { id: 2, name: '{main}', source: { name: 'index.php', path: `${fakeWorkspacePath}/index.php` }, line: 1, column: 1 },
          ],
        };
      case 'scopes':
        return { scopes: [{ name: 'Locals', variablesReference: 100, expensive: false, namedVariables: 3 }] };
      case 'variables': {
        if (args.variablesReference === 100) {
          return {
            variables: [
              { name: 'str', value: '"hello"', type: 'string', variablesReference: 0 },
              { name: 'num', value: '42', type: 'int', variablesReference: 0 },
              { name: 'arr', value: '[1,2,3]', type: 'array', variablesReference: 200, indexedVariables: 3 },
              { name: 'obj', value: '{...}', type: 'object', variablesReference: 0 },
            ],
          };
        }
        if (args.variablesReference === 200) {
          return { variables: [
            { name: '[0]', value: '1', variablesReference: 0 },
            { name: '[1]', value: '2', variablesReference: 0 },
            { name: '[2]', value: '3', variablesReference: 0 },
          ] };
        }
        return { variables: [] };
      }
      case 'evaluate':
        return { result: `eval(${JSON.stringify(args.expression)}) => "hello"`, variablesReference: 0 };
      case 'setBreakpoints': {
        const lines = (args.breakpoints ?? []).map((bp) => bp.line);
        return { breakpoints: lines.map((line, i) => ({ id: i + 1, verified: true, line, source: args.source })) };
      }
      case 'setExceptionBreakpoints':
        return {};
      case 'continue':
        return { allThreadsContinued: true };
      case 'next':
      case 'stepIn':
      case 'stepOut':
      case 'pause':
      case 'restart':
      case 'terminate':
      case 'disconnect':
        return {};
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  },
};

// ---------------------------------------------------------------------------
// 3. Minimal `vscode` stub (only what the bridge touches)
// ---------------------------------------------------------------------------
const vscodeStub = {
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => `file://${p}`, scheme: 'file', path: p }),
    parse: (v) => ({ fsPath: v, toString: () => v, scheme: v.startsWith('file://') ? 'file' : 'http', path: v }),
    joinPath: (uri, ...seg) => ({ fsPath: `${uri.fsPath}/${seg.join('/')}`, toString: () => `file://${uri.fsPath}/${seg.join('/')}`, scheme: 'file' }),
  },
  workspace: {
    workspaceFolders: [fakeSession.workspaceFolder],
    fs: { stat: async () => ({}) },
  },
  debug: {
    activeDebugSession: fakeSession,
    onDidStartDebugSession: () => ({ dispose() {} }),
    onDidTerminateDebugSession: () => ({ dispose() {} }),
    onDidChangeActiveDebugSession: () => ({ dispose() {} }),
    onDidChangeBreakpoints: () => ({ dispose() {} }),
    addBreakpoints: () => {},
    removeBreakpoints: () => {},
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  Position: class {
    constructor(line, character) { this.line = line; this.character = character; }
  },
  Location: class {
    constructor(uri, position) { this.uri = uri; this.range = { start: position, end: position }; }
  },
  SourceBreakpoint: class {
    constructor(location, enabled = true, condition, hitCondition, logMessage) {
      this.location = location; this.enabled = enabled; this.condition = condition; this.hitCondition = hitCondition; this.logMessage = logMessage;
    }
  },
  FunctionBreakpoint: class {
    constructor(name, enabled = true, condition, hitCondition, logMessage) {
      this.name = name; this.enabled = enabled; this.condition = condition; this.hitCondition = hitCondition; this.logMessage = logMessage;
    }
  },
};

// Wire addBreakpoints → onDidChangeBreakpoints so breakpoint verification resolves (like real VS Code).
const bpChangeListeners = [];
vscodeStub.debug.onDidChangeBreakpoints = (listener) => {
  bpChangeListeners.push(listener);
  return { dispose() { bpChangeListeners.splice(bpChangeListeners.indexOf(listener), 1); } };
};
vscodeStub.debug.addBreakpoints = (bps) => {
  for (const listener of bpChangeListeners) {
    listener({ added: bps, changed: [], removed: [] });
  }
};
vscodeStub.debug.removeBreakpoints = () => {};
fakeSession.getDebugProtocolBreakpoint = async (bp) => ({
  verified: true,
  line: bp.location.range.start.line + 1,
  source: { name: 'index.php', path: bp.location.uri.fsPath },
});

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// 4. Boot the real server + real MCP client, then exercise the protocol
// ---------------------------------------------------------------------------
const { startHttpServer, stopHttpServer, registerSessionTracking } = require(bundlePath);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const results = [];
const ok = (label, value) => { results.push([label, value]); };

async function main() {
  // Wire session tracking (extension.ts does this inside VS Code) so
  // set_breakpoint verification resolves via onDidChangeBreakpoints.
  registerSessionTracking([]);

  const uri = await startHttpServer({ version: '0.1.0-demo' });
  ok('server uri', uri);

  // Show the port file that external clients use for discovery
  const portInfo = JSON.parse(fs.readFileSync(portFile, 'utf8'));
  ok('port file', `${portInfo.uri} (pid ${portInfo.pid}, started ${portInfo.started})`);

  const client = new Client({ name: 'standalone-demo', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(uri)));

  // --- protocol surface --------------------------------------------------
  const tools = await client.listTools();
  ok('tools/list', `${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`);

  const resources = await client.listResources();
  ok('resources/list', `${resources.resources.length} resources: ${resources.resources.map((r) => r.uri).join(', ')}`);

  const stackResource = await client.readResource({ uri: 'xdebug://stack' });
  const stackText = stackResource.contents[0]?.text ?? '';
  ok('readResource xdebug://stack', `first line: ${stackText.split('\n')[0] ?? '(empty)'}`);

  // --- session + inspection tools -----------------------------------------
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args ?? {} });
    const text = res.content?.[0]?.text ?? JSON.stringify(res);
    try { return JSON.parse(text); } catch { return text; }
  };

  const sessions = await call('list_sessions');
  ok('tools/call list_sessions', JSON.stringify(sessions));

  const st = await call('status');
  const statusInfo = st.status ?? st;
  ok('tools/call status', `stopped=${statusInfo.stopped}, threadId=${statusInfo.threadId}`);

  const threads = await call('threads');
  ok('tools/call threads', JSON.stringify(threads.threads ?? threads));

  const frames = await call('stack');
  const frameList = frames.frames ?? frames;
  ok('tools/call stack', `${frameList.length} frames: ${frameList.map((f) => f.name).join(' ← ')}`);

  const scopes = await call('scopes', { frameId: 0 });
  const scopeList = scopes.scopes ?? scopes;
  ok('tools/call scopes', scopeList.map((s) => `${s.name} (ref ${s.variablesReference})`).join(', '));

  const vars = await call('variables', { variablesReference: 100 });
  const varList = vars.variables ?? vars;
  ok('tools/call variables', varList.map((v) => `${v.name}=${v.value}`).join(', '));

  const ev = await call('evaluate_expr', { expr: '2 + 2' });
  ok('tools/call evaluate_expr', JSON.stringify(ev));

  const cont = await call('continue');
  ok('tools/call continue', JSON.stringify(cont));

  const bp = await call('set_breakpoint', { file: `${fakeWorkspacePath}/index.php`, breakpoints: [{ line: 12 }, { line: 15, condition: '$i > 3' }] });
  ok('tools/call set_breakpoint', JSON.stringify(bp));

  await client.close();
  await stopHttpServer();
}

main()
  .then(() => {
    console.log('\n=== Standalone MCP demo (real HTTP server + real MCP SDK client) ===\n');
    for (const [label, value] of results) {
      console.log(`  ${label.padEnd(38)} ${value}`);
    }
    console.log('\nAll steps completed successfully. Server stopped, port file cleaned up.');
  })
  .catch(async (err) => {
    console.error('\nDemo FAILED:', err);
    await stopHttpServer().catch(() => {});
    process.exitCode = 1;
  });
