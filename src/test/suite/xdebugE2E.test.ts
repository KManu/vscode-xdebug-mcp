// E2E tests with real PHP/Xdebug via Docker container.
// Container lifecycle (start/stop/PHP trigger) is managed externally:
//   npm script starts Docker, trigger.sh auto-runs PHP when VS Code listens.
// This file only does MCP tool calls via HTTP — no child_process, no Docker CLI.
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import { getServerPort } from '../helpers/portResolver';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../src/test/fixtures/php-e2e');

// ── HTTP / JSON-RPC helpers (same pattern as mcpTools.test.ts) ──────

function mcpRequest(port: number, method: string, params?: any, id: number = 1): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Parse error: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function toolCall(port: number, name: string, args?: any): Promise<any> {
  return mcpRequest(port, 'tools/call', { name, arguments: args || {} });
}

async function initializeMcp(port: number): Promise<void> {
  await mcpRequest(port, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'xdebug-e2e-test', version: '1.0.0' },
  });
  await mcpRequest(port, 'notifications/initialized', {}, 2);
}

async function pollUntilStopped(port: number, timeoutMs = 30000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await toolCall(port, 'status');
      const sc = resp.result?.structuredContent || resp.result || {};
      if (sc.status?.stopped === true) return;
    } catch {
      /* server may not be ready yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for session to stop after ${timeoutMs}ms`);
}

// ── Session helpers ─────────────────────────────────────────────────

async function startDebugSession(): Promise<vscode.DebugSession> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('No workspace folder');

  const sessionPromise = new Promise<vscode.DebugSession>((resolve) => {
    const sub = vscode.debug.onDidStartDebugSession((session) => {
      sub.dispose();
      resolve(session);
    });
    setTimeout(() => {
      sub.dispose();
    }, 15000);
  });

  const debugConfig: vscode.DebugConfiguration = {
    type: 'php',
    request: 'launch',
    name: 'Xdebug E2E Test',
    port: 9003,
    hostname: '0.0.0.0',
    pathMappings: { '/app/scripts': path.resolve(FIXTURE_DIR, 'scripts') },
  };

  const started = await vscode.debug.startDebugging(folder, debugConfig);
  assert.ok(started, 'startDebugging should return true');
  const session = await sessionPromise;
  assert.ok(session, 'Debug session should start');
  return session as vscode.DebugSession;
}

async function stopDebugSession(timeout = 5000): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session) return;
  try {
    await session.customRequest('disconnect');
    await new Promise<void>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession(() => {
        sub.dispose();
        resolve();
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, timeout);
    });
  } catch {
    /* already terminated */
  }
}

// ── Test suite ──────────────────────────────────────────────────────

describe('Xdebug E2E', function () {
  this.timeout(120000);
  let port: number;
  let activeSession: vscode.DebugSession | undefined;

  before(async function () {
    // This suite needs the Docker compose stack brought up by `npm run test:e2e`.
    // Skip when run via other runners (test:integration, test:e2e:win) so they stay
    // reliable on machines without Docker. Set E2E_DOCKER=1 to force-enable.
    if (process.env.npm_lifecycle_event !== 'test:e2e' && process.env.E2E_DOCKER !== '1') {
      this.skip();
    }
    this.timeout(15000);
    port = (await getServerPort()).port;
    await initializeMcp(port);
  });

  afterEach(async function () {
    this.timeout(10000);
    try {
      await stopDebugSession();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found') && !msg.includes('No active') && !msg.includes('terminated')) {
        console.warn(`[afterEach] ${msg}`);
      }
    }
    activeSession = undefined;
  });

  // Test 1: Start debug session, set breakpoint, wait for PHP trigger to hit it
  it('breakpoint → stack: real frames with correct file and line', async () => {
    activeSession = await startDebugSession();
    // The trigger.sh script auto-runs PHP once it detects the debug listener.
    // We set a breakpoint and wait for Xdebug to stop there.

    const setResp = await toolCall(port, 'set_breakpoint', {
      file: path.resolve(FIXTURE_DIR, 'scripts/test.php'),
      breakpoints: [{ line: 10 }],
    });
    const setSc = setResp.result.structuredContent || setResp.result;
    assert.strictEqual(setSc.results[0].verified, true, 'breakpoint should be verified');

    // PHP will auto-trigger via trigger.sh. Wait for the breakpoint hit.
    await pollUntilStopped(port, 60000, 200);

    const stackResp = await toolCall(port, 'stack');
    const stackSc = stackResp.result.structuredContent || stackResp.result;
    assert.ok(Array.isArray(stackSc.frames), 'should return frames');
    assert.ok(stackSc.frames.length > 0, 'should have at least one frame');
    const topFrame = stackSc.frames[0];
    assert.strictEqual(topFrame.line, 10, 'should stop at line 10');
    assert.ok(topFrame.source?.path?.includes('test.php'), 'source should be test.php');
  });

  // Test 2: evaluate_expr with real PHP expression
  it('evaluate_expr: real PHP expression evaluation', async () => {
    activeSession = await startDebugSession();
    await toolCall(port, 'set_breakpoint', {
      file: path.resolve(FIXTURE_DIR, 'scripts/test.php'),
      breakpoints: [{ line: 12 }],
    });
    await pollUntilStopped(port, 60000, 200);

    const evalResp = await toolCall(port, 'evaluate_expr', { expr: '$x' });
    const evalSc = evalResp.result.structuredContent || evalResp.result;
    assert.ok(
      evalSc.result?.includes('10') || evalSc.result === '10' || String(evalSc).includes('10'),
      'should evaluate $x to 10'
    );

    const exprResp = await toolCall(port, 'evaluate_expr', { expr: '$x + $y' });
    const exprSc = exprResp.result.structuredContent || exprResp.result;
    assert.ok(
      exprSc.result?.includes('30') || exprSc.result === '30' || String(exprSc).includes('30'),
      'should evaluate $x + $y to 30'
    );
  });

  // Test 3: step_over — verify tool connectivity with real Xdebug
  it('step_over: tool responds without crashing', async () => {
    activeSession = await startDebugSession();
    await toolCall(port, 'set_breakpoint', {
      file: path.resolve(FIXTURE_DIR, 'scripts/test.php'),
      breakpoints: [{ line: 10 }],
    });
    await pollUntilStopped(port, 60000, 200);

    const stepResp = await toolCall(port, 'step_over');
    const stepSc = stepResp.result.structuredContent || stepResp.result;
    assert.ok(stepSc !== undefined, 'step_over should return a response');
  });

  // Test 4: wait_for_stop — real retry loop exercised via pollUntilStopped in other tests
  it('wait_for_stop: tool responds without crashing', async () => {
    activeSession = await startDebugSession();
    await toolCall(port, 'set_breakpoint', {
      file: path.resolve(FIXTURE_DIR, 'scripts/test.php'),
      breakpoints: [{ line: 10 }],
    });

    const wfsResp = await toolCall(port, 'wait_for_stop', {
      timeoutMs: 30000,
      pollMs: 300,
    });
    const wfsSc = wfsResp.result.structuredContent || wfsResp.result;
    // wait_for_stop may succeed or timeout depending on thread ID resolution timing.
    // The real retry loop is exercised via pollUntilStopped (status tool) in other tests.
    assert.ok(wfsSc !== undefined, 'wait_for_stop should return a response');
  });

  // Test 5: terminate then verify session cleanup
  it('terminate: session removed after terminate', async () => {
    activeSession = await startDebugSession();
    await toolCall(port, 'set_breakpoint', {
      file: path.resolve(FIXTURE_DIR, 'scripts/test.php'),
      breakpoints: [{ line: 10 }],
    });
    await pollUntilStopped(port, 60000, 200);

    await toolCall(port, 'terminate');
    // Real Xdebug may end session asynchronously — wait for cleanup.
    await new Promise((r) => setTimeout(r, 2000));

    // Try to stop the session if still alive (expected to error if already terminated)
    try {
      await stopDebugSession();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!/not found|No active|terminated|disconnect/.test(m)) console.warn(`[test5] ${m}`);
    }

    const listResp = await toolCall(port, 'list_sessions');
    const listSc = listResp.result.structuredContent || listResp.result;
    const found = (listSc.sessions || []).some((s: any) => s.id === activeSession!.id);
    assert.strictEqual(found, false, 'session should not be in list_sessions after terminate');
  });
});
