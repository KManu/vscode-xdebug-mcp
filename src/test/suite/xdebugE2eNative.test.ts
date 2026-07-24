// E2E tests with native Windows PHP+Xdebug.
//
// The xdebug.php-debug adapter drives the PHP lifecycle itself in `launch`
// mode (runtimeExecutable + program), so there is no external child_process
// trigger and no spawn/listener race. Each test:
//   1. startDebugging (adapter spawns PHP; stopOnEntry halts it on line 1)
//   2. pollUntilStopped  (session stopped at entry)
//   3. MCP set_breakpoint (the tool under test) at the target line
//   4. MCP continue        (PHP resumes, hits the breakpoint)
//   5. pollUntilStopped    (session stopped at the breakpoint)
//   6. MCP stack / evaluate_expr / step_over / wait_for_stop / terminate
//
// Requires: XAMPP + Xdebug (C:/xampp/php/php.exe) configured to connect to
// 127.0.0.1:9003. Run `node scripts/setup-e2e-win.js` once (auto-run by the
// test:e2e:win script) to point vscode-test at the local VS Code + pre-install
// the xdebug.php-debug adapter.
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import { getServerPort } from '../helpers/portResolver';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'src', 'test', 'fixtures', 'php-e2e');
const FIXTURE_SCRIPT = path.resolve(FIXTURE_DIR, 'scripts/test.php');
const PHP_EXE = 'C:/xampp/php/php.exe';

// ── HTTP / JSON-RPC helpers (same pattern as xdebugE2E.test.ts) ──────

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
        res.on('data', (chunk: Buffer) => (data += chunk));
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
    clientInfo: { name: 'xdebug-e2e-native-test', version: '1.0.0' },
  });
  await mcpRequest(port, 'notifications/initialized', {}, 2);
}

async function pollUntilStopped(port: number, timeoutMs = 60000, intervalMs = 200): Promise<void> {
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

async function pollUntilSessionGone(
  port: number,
  sessionId: string,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await toolCall(port, 'list_sessions');
    const sc = resp.result?.structuredContent || resp.result || {};
    const found = (sc.sessions || []).some((s: any) => s.id === sessionId);
    if (!found) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to be removed after ${timeoutMs}ms`);
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

  // The adapter spawns PHP itself (runtimeExecutable + program) and halts it on
  // entry (stopOnEntry). Xdebug then connects back to the adapter on port 9003.
  const debugConfig: vscode.DebugConfiguration = {
    type: 'php',
    request: 'launch',
    name: 'Xdebug Native E2E Test',
    port: 9003,
    hostname: '127.0.0.1',
    runtimeExecutable: PHP_EXE,
    program: FIXTURE_SCRIPT,
    env: { XDEBUG_MODE: 'debug', XDEBUG_SESSION: '1' },
    stopOnEntry: true,
    log: true,
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

describe('Xdebug E2E Native', function () {
  this.timeout(120000);
  let port: number;
  let activeSession: vscode.DebugSession | undefined;

  before(async function () {
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

  // Test 1: set a breakpoint, continue onto it, read the real stack.
  it('breakpoint → stack: real frames with correct file and line', async () => {
    activeSession = await startDebugSession();
    await pollUntilStopped(port); // stopped at entry

    const setResp = await toolCall(port, 'set_breakpoint', {
      file: FIXTURE_SCRIPT,
      breakpoints: [{ line: 10 }],
    });
    const setSc = setResp.result.structuredContent || setResp.result;
    assert.strictEqual(setSc.results[0].verified, true, 'breakpoint should be verified');

    await toolCall(port, 'continue'); // run to the breakpoint
    await pollUntilStopped(port);

    const stackResp = await toolCall(port, 'stack');
    const stackSc = stackResp.result.structuredContent || stackResp.result;
    assert.ok(Array.isArray(stackSc.frames), 'should return frames');
    assert.ok(stackSc.frames.length > 0, 'should have at least one frame');
    const topFrame = stackSc.frames[0];
    assert.strictEqual(topFrame.line, 10, 'should stop at line 10');
    assert.ok(topFrame.source?.path?.includes('test.php'), 'source should be test.php');
  });

  // Test 2: evaluate real PHP expressions at a breakpoint.
  it('evaluate_expr: real PHP expression evaluation', async () => {
    activeSession = await startDebugSession();
    await pollUntilStopped(port);

    await toolCall(port, 'set_breakpoint', {
      file: FIXTURE_SCRIPT,
      breakpoints: [{ line: 12 }],
    });
    await toolCall(port, 'continue');
    await pollUntilStopped(port);

    const evalResp = await toolCall(port, 'evaluate_expr', { expr: '$x' });
    const evalSc = evalResp.result.structuredContent || evalResp.result;
    assert.ok(
      evalSc.result?.includes('10') || evalSc.result === '10' || String(evalSc).includes('10'),
      `should evaluate $x to 10, got: ${JSON.stringify(evalSc).slice(0, 200)}`
    );

    const exprResp = await toolCall(port, 'evaluate_expr', { expr: '$x + $y' });
    const exprSc = exprResp.result.structuredContent || exprResp.result;
    assert.ok(
      exprSc.result?.includes('30') || exprSc.result === '30' || String(exprSc).includes('30'),
      `should evaluate $x + $y to 30, got: ${JSON.stringify(exprSc).slice(0, 200)}`
    );
  });

  // Test 3: step_over against a real Xdebug session.
  it('step_over: tool responds, session stays stopped', async () => {
    activeSession = await startDebugSession();
    await pollUntilStopped(port);

    await toolCall(port, 'set_breakpoint', {
      file: FIXTURE_SCRIPT,
      breakpoints: [{ line: 10 }],
    });
    await toolCall(port, 'continue');
    await pollUntilStopped(port);

    const stepResp = await toolCall(port, 'step_over');
    const stepSc = stepResp.result.structuredContent || stepResp.result;
    assert.ok(stepSc !== undefined, 'step_over should return a response');
    await pollUntilStopped(port); // step lands, session stopped again
  });

  // Test 4: wait_for_stop returns stopped:true with a frame.
  it('wait_for_stop: returns stopped:true', async () => {
    activeSession = await startDebugSession();
    // Ensure the session is stopped (status-based, reliable) before querying,
    // then resolve the real thread id so wait_for_stop's internal stack() call
    // doesn't race with adapter init.
    await pollUntilStopped(port);
    const threadsResp = await toolCall(port, 'threads');
    const tid = threadsResp.result?.structuredContent?.threads?.[0]?.id ?? threadsResp.result?.threads?.[0]?.id ?? 1;
    const wfsResp = await toolCall(port, 'wait_for_stop', {
      threadId: tid,
      timeoutMs: 30000,
      pollMs: 300,
    });
    const wfsSc = wfsResp.result.structuredContent || wfsResp.result;
    assert.ok(wfsSc !== undefined, 'wait_for_stop should return a response');
    assert.strictEqual(wfsSc.stopped, true, 'wait_for_stop should report stopped:true');
  });

  // Test 5: terminate removes the session from list_sessions.
  it('terminate: session removed after terminate', async () => {
    activeSession = await startDebugSession();
    await pollUntilStopped(port);
    await toolCall(port, 'set_breakpoint', {
      file: FIXTURE_SCRIPT,
      breakpoints: [{ line: 10 }],
    });
    await toolCall(port, 'continue');
    await pollUntilStopped(port);

    const termResp = await toolCall(port, 'terminate');
    const termSc = termResp.result.structuredContent || termResp.result;
    assert.strictEqual(termSc.success, true, 'terminate should succeed');

    // terminate() internally falls back to disconnect({terminateDebuggee:true})
    // for adapters (e.g. xdebug.php-debug) that don't fire `terminated` on a
    // terminate DAP request — so the session should disappear on its own.
    await pollUntilSessionGone(port, activeSession.id, 15000);

    const listResp = await toolCall(port, 'list_sessions');
    const listSc = listResp.result.structuredContent || listResp.result;
    const found = (listSc.sessions || []).some((s: any) => s.id === activeSession!.id);
    assert.strictEqual(found, false, 'session should not be in list_sessions after terminate');
  });
});
