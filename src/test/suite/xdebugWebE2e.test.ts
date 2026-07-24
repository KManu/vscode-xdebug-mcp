// Web-flow E2E: Apache serves a real PHP page → Xdebug connects to a
// listening VS Code debug session → the extension identifies the session
// and exposes it via the MCP HTTP API.
//
// This proves the core value proposition: any LLM / MCP client hitting the
// server URL can discover and inspect the live PHP debug session. Unlike
// xdebugE2eNative.test.ts (which spawns PHP CLI), this exercises the real
// "listen for Xdebug" web flow that xdebug.php-debug ships:
//   vscode.debug.startDebugging(folder, { type:'php', request:'launch',
//                                          port:9003 /* no program */ })
//
// Requires: XAMPP Apache on 127.0.0.1:80, Xdebug on 9003, htdocs writable.
// NOTE: use 127.0.0.1 (not localhost) — on this machine localhost resolves
// to IPv6 ::1, which hits a different (Debian/WSL) Apache, not XAMPP.
// Self-skips if Apache is down, htdocs isn't writable, or Xdebug isn't
// loaded in Apache's PHP (restart Apache so it re-reads php.ini).
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { getServerPort } from '../helpers/portResolver';

const HTDOCS = 'C:/xampp/htdocs/xdebug-mcp-e2e';
const TEST_PAGE_PATH = path.join(HTDOCS, 'test.php');
const TEST_PAGE_URL = 'http://127.0.0.1/xdebug-mcp-e2e/test.php';
const BREAKPOINT_LINE = 4;

// A PHP page with a stable, significant breakpoint line. LINE NUMBERS MATTER.
// The breakpoint is on line 4 (after $page is assigned on line 3), so the
// stopped frame has $page available for evaluate_expr.
const TEST_PAGE = `<?php
/* Apache + Xdebug web-flow E2E fixture. */
$page = "apache-xdebug-e2e";   // line 3 — assigns $page (read at the line-4 breakpoint)
$sum = 0;   // line 4 — breakpoint target
for ($i = 1; $i <= 5; $i++) { $sum += $i; }
echo "sum=$sum page=$page\\n";
echo "done\\n";
`;

// ── HTTP / JSON-RPC helpers (same shape as the native e2e) ───────────

function mcpRequest(port: number, method: string, params?: any, id = 1): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const req = http.request({
      hostname: 'localhost', port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
const toolCall = (port: number, name: string, args?: any) => mcpRequest(port, 'tools/call', { name, arguments: args || {} });

async function initializeMcp(port: number): Promise<void> {
  await mcpRequest(port, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'xdebug-web-e2e-test', version: '1.0.0' },
  });
  await mcpRequest(port, 'notifications/initialized', {}, 2);
}

async function pollUntilStopped(port: number, timeoutMs = 60000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await toolCall(port, 'status');
      const sc = r.result?.structuredContent || r.result || {};
      if (sc.status?.stopped === true) return;
    } catch { /* server may not be ready yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for session to stop after ${timeoutMs}ms`);
}

// Uses Node's http (no curl, no shell) — portable and works in the EH.
function apacheAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1/', (res) => { res.resume(); resolve(res.statusCode !== undefined); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

// Confirms Xdebug is loaded in Apache's PHP. If Apache is running with a
// stale php.ini (before Xdebug was added), the breakpoint would never be hit
// and the test would time out at 60s — so we probe and skip cleanly instead.
// Uses execFileSync (no shell) to avoid cmd.exe mangling curl args.
function xdebugLoadedInApache(): boolean {
  const probePath = path.join(HTDOCS, '__probe.php');
  try {
    fs.writeFileSync(probePath, '<?php echo extension_loaded("xdebug") ? "XDEBUG-LOADED" : "XDEBUG-ABSENT";');
    const out = execFileSync('curl', ['-s', 'http://127.0.0.1/xdebug-mcp-e2e/__probe.php'], { timeout: 4000, encoding: 'utf8' });
    return out.includes('XDEBUG-LOADED');
  } catch { return false; }
  finally { try { fs.unlinkSync(probePath); } catch { /* probe already removed */ } }
}

// ── Suite ───────────────────────────────────────────────────────────

describe('Xdebug E2E Native - Web (Apache)', function () {
  this.timeout(120000);
  let port: number;
  let curlProc: ReturnType<typeof spawn> | undefined;
  let listenSession: vscode.DebugSession | undefined;

  before(async function () {
    this.timeout(20000);
    if (!(await apacheAvailable())) {
      console.log('[web-e2e] Apache not reachable on 127.0.0.1 — skipping web-flow tests.');
      this.skip();
    }
    try { fs.mkdirSync(HTDOCS, { recursive: true }); }
    catch {
      console.log('[web-e2e] htdocs not writable — skipping web-flow tests.');
      this.skip();
    }
    if (!xdebugLoadedInApache()) {
      console.log('[web-e2e] Xdebug not loaded in Apache\'s PHP — restart Apache so it re-reads php.ini, then retry. Skipping.');
      try { fs.rmSync(HTDOCS, { recursive: true, force: true }); }
      catch (e: unknown) { console.warn(`[web-e2e] htdocs cleanup: ${e instanceof Error ? e.message : String(e)}`); }
      this.skip();
    }
    fs.writeFileSync(TEST_PAGE_PATH, TEST_PAGE);
    port = (await getServerPort()).port;
    await initializeMcp(port);
  });

  after(async function () {
    this.timeout(15000);
    if (listenSession) {
      try { await listenSession.customRequest('disconnect', { terminateDebuggee: true }); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/terminated|not found|No active/i.test(msg)) console.warn(`[web-e2e after] disconnect: ${msg}`);
      }
    }
    try { fs.rmSync(HTDOCS, { recursive: true, force: true }); }
    catch (err: unknown) { console.warn(`[web-e2e after] cleanup htdocs: ${err instanceof Error ? err.message : String(err)}`); }
    if (curlProc && !curlProc.killed) {
      try { curlProc.kill(); } catch (err: unknown) {
        if (!/ESRCH|not running/i.test(err instanceof Error ? err.message : String(err))) { /* process already gone */ }
      }
    }
  });

  // Core: a real Apache-served PHP page, a real Xdebug connection, and the
  // extension identifying + exposing the session through the MCP API.
  it('identifies an Apache/Xdebug PHP session and exposes it via the MCP API', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'workspace folder required');

    const sessionPromise = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((s) => {
        if (s.type === 'php') { sub.dispose(); resolve(s); }
      });
      setTimeout(() => { sub.dispose(); resolve(undefined as any); }, 15000);
    });

    // Listen-only: no program. The adapter waits on 9003 for an incoming
    // Xdebug connection (same config the adapter's own "Listen for Xdebug"
    // command uses).
    const started = await vscode.debug.startDebugging(folder, {
      name: 'Listen for Xdebug (web e2e)',
      type: 'php',
      request: 'launch',
      port: 9003,
      hostname: '127.0.0.1',
      stopOnEntry: false, // run straight into our breakpoint
      log: true,
    });
    assert.ok(started, 'listen-mode startDebugging should return true');
    listenSession = await sessionPromise;
    assert.ok(listenSession, 'a type:php debug session should start (listening on 9003)');

    // The extension must already be tracking it (onDidStartDebugSession).
    const listBefore = await toolCall(port, 'list_sessions');
    const listBeforeSc = listBefore.result.structuredContent || listBefore.result;
    const phpSession = (listBeforeSc.sessions || []).find((s: any) => s.type === 'php');
    assert.ok(phpSession, 'MCP list_sessions should expose the listening PHP session BEFORE a request');
    assert.strictEqual(phpSession.type, 'php', 'exposed session must be identified as type php');

    // Set the breakpoint via the MCP tool (the path the LLM would use).
    const setResp = await toolCall(port, 'set_breakpoint', {
      file: TEST_PAGE_PATH, breakpoints: [{ line: BREAKPOINT_LINE }],
    });
    const setSc = setResp.result.structuredContent || setResp.result;
    assert.strictEqual(setSc.results[0].verified, true, 'breakpoint should verify against the htdocs page');

    // Trigger the page via Apache. PHP runs under XAMPP's PHP, Xdebug
    // connects back to 9003, and execution halts at our breakpoint.
    // NOTE: curl BLOCKS while PHP is paused at the breakpoint, so spawn it
    // detached and do NOT await. stdio:'ignore' discards the body (no -o needed).
    curlProc = spawn('curl', ['-s', TEST_PAGE_URL], { detached: true, stdio: 'ignore' });
    curlProc.unref();

    await pollUntilStopped(port);

    // The session is now stopped at the breakpoint — verify the MCP API
    // reports accurate state that an LLM would rely on.
    const statusResp = await toolCall(port, 'status');
    const statusSc = statusResp.result.structuredContent || statusResp.result;
    assert.strictEqual(statusSc.status.stopped, true, 'status should report stopped:true');

    const stackResp = await toolCall(port, 'stack');
    const stackSc = stackResp.result.structuredContent || stackResp.result;
    assert.ok(Array.isArray(stackSc.frames), 'stack should return frames');
    const top = stackSc.frames[0];
    assert.strictEqual(top.line, BREAKPOINT_LINE, `should stop at line ${BREAKPOINT_LINE}`);
    assert.ok(top.source?.path?.includes('test.php'), 'frame source should be the htdocs test.php');

    // evaluate_expr at the stopped frame — proves the LLM can read live PHP state.
    const evalResp = await toolCall(port, 'evaluate_expr', { expr: '$page' });
    const evalSc = evalResp.result.structuredContent || evalResp.result;
    assert.ok(
      String(evalSc.result ?? evalSc).includes('apache-xdebug-e2e'),
      `evaluate $page should return "apache-xdebug-e2e", got: ${JSON.stringify(evalSc).slice(0, 200)}`,
    );
  });
});
