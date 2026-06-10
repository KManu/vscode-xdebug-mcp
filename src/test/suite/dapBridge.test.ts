// src/test/suite/dapBridge.test.ts
// Integration tests for DAP communication via vscode.debug API.
// Uses the mock debug adapter (type: 'xdebug-mcp-test'). No HTTP calls.
import * as vscode from 'vscode';
import * as assert from 'assert';
import { __resolveFileUriForTesting } from '../../debug/dapBridge';

// Session management helpers.
let activeSession: vscode.DebugSession | undefined;

function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder found');
  }
  return folders[0];
}

async function startDebugSession(): Promise<vscode.DebugSession> {
  const workspaceFolder = getWorkspaceFolder();

  // Listen for onDidStartDebugSession BEFORE calling startDebugging.
  const startedPromise = new Promise<vscode.DebugSession>((resolve) => {
    const sub = vscode.debug.onDidStartDebugSession((session) => {
      sub.dispose();
      resolve(session);
    });
    // Timeout safety.
    setTimeout(() => {
      sub.dispose();
      resolve(undefined as unknown as vscode.DebugSession);
    }, 5000);
  });

  const started = await vscode.debug.startDebugging(
    workspaceFolder,
    {
      type: 'xdebug-mcp-test',
      name: 'Test',
      request: 'launch',
    }
  );

  assert.ok(started, 'startDebugging should return true');

  activeSession = await startedPromise;
  assert.ok(activeSession, 'Debug session should start');

  // Give the mock debug adapter time to process configurationDone
  // and fire its internal 'stopped' event (100ms delay in the mock).
  // Standard DAP events like 'stopped' are NOT forwarded to
  // onDidReceiveDebugSessionCustomEvent, so we use a short delay.
  await new Promise((resolve) => setTimeout(resolve, 200));

  return activeSession;
}

async function stopDebugSession(session: vscode.DebugSession): Promise<void> {
  try {
    // Only disconnect if we haven't already terminated.
    await session.customRequest('disconnect', { terminateDebuggee: true });
  } catch {
    // Session may already be terminated — fine.
  }

  // Wait for the terminate event.
  await new Promise<void>((resolve) => {
    const sub = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.id === session.id) {
        sub.dispose();
        resolve();
      }
    });
    setTimeout(() => {
      sub.dispose();
      resolve();
    }, 3000);
  });
}

describe('DAP Bridge', function () {
  this.timeout(15000);

  // ── Lifecycle tests ─────────────────────────────────────────

  describe('Session Lifecycle', function () {
    it('starts a debug session — onDidStartDebugSession fires', async function () {
      const workspaceFolder = getWorkspaceFolder();

      const sessionPromise = new Promise<vscode.DebugSession>((resolve) => {
        const sub = vscode.debug.onDidStartDebugSession((session) => {
          sub.dispose();
          resolve(session);
        });
        setTimeout(() => {
          sub.dispose();
          resolve(undefined as unknown as vscode.DebugSession);
        }, 5000);
      });

      const started = await vscode.debug.startDebugging(
        workspaceFolder,
        { type: 'xdebug-mcp-test', name: 'Test', request: 'launch' }
      );
      assert.ok(started, 'startDebugging should return true');

      const session = await sessionPromise;
      assert.ok(session, 'onDidStartDebugSession should fire');
      assert.ok(vscode.debug.activeDebugSession, 'activeDebugSession should be populated');

      await stopDebugSession(session);
    });

    it('session end — onDidTerminateDebugSession fires after disconnect', async function () {
      const session = await startDebugSession();

      let terminatedFired = false;
      const terminatedPromise = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s.id === session.id) {
            terminatedFired = true;
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 5000);
      });

      await session.customRequest('disconnect', { terminateDebuggee: true });
      await terminatedPromise;

      assert.strictEqual(terminatedFired, true,
        'onDidTerminateDebugSession should fire on disconnect');
    });
  });

  // ── Inspection commands ─────────────────────────────────────

  describe('Inspection via customRequest', function () {
    let session: vscode.DebugSession;

    beforeEach(async function () {
      session = await startDebugSession();
    });

    afterEach(async function () {
      if (session) {
        await stopDebugSession(session);
      }
    });

    it('stackTrace returns frames', async function () {
      const response = (await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 10,
      })) as { stackFrames?: Array<{ id: number; name: string; line: number }> };

      assert.ok(response.stackFrames, 'stackTrace should return stackFrames');
      assert.ok(response.stackFrames.length > 0, 'should have at least one frame');
      assert.strictEqual(typeof response.stackFrames[0].id, 'number');
      assert.strictEqual(typeof response.stackFrames[0].name, 'string');
    });

    it('scopes returns scopes', async function () {
      const response = (await session.customRequest('scopes', {
        frameId: 1,
      })) as { scopes?: Array<{ name: string; variablesReference: number }> };

      assert.ok(response.scopes, 'scopes should return scopes');
      assert.ok(response.scopes.length > 0, 'should have at least one scope');
      assert.strictEqual(typeof response.scopes[0].variablesReference, 'number');
    });

    it('variables returns variables', async function () {
      const response = (await session.customRequest('variables', {
        variablesReference: 100,
      })) as { variables?: Array<{ name: string; value: string }> };

      assert.ok(response.variables, 'variables should return variables');
      assert.ok(response.variables.length > 0, 'should have at least one variable');
      assert.strictEqual(response.variables[0].name, 'str', 'first variable should be named str');
      assert.strictEqual(response.variables[1].name, 'num', 'second variable should be named num');
    });

    it('evaluate returns result', async function () {
      const response = (await session.customRequest('evaluate', {
        expression: '1 + 1',
        frameId: 1,
      })) as { result: string; type: string };

      // The mock adapter uses eval() so '1 + 1' → eval gives 2 → String(2) gives '2'.
      assert.strictEqual(response.result, '2');
      // The mock does not set a type field, so it will be undefined.
      assert.ok(typeof response.result === 'string');
    });
  });

  // ── Execution control commands ──────────────────────────────

  describe('Execution Control', function () {
    let session: vscode.DebugSession;

    beforeEach(async function () {
      session = await startDebugSession();
    });

    afterEach(async function () {
      try {
        await stopDebugSession(session);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('not found') && !msg.includes('No active') &&
            !msg.includes('terminated') && !msg.includes('disconnect')) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
    });

    it('next returns success', async function () {
      await session.customRequest('next', { threadId: 1 });
      // Session is still active after step — verify by calling stackTrace.
      const response = await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      }) as { stackFrames?: unknown[] };
      assert.ok(response.stackFrames, 'stackTrace should succeed after next');
    });

    it('stepIn returns success', async function () {
      await session.customRequest('stepIn', { threadId: 1 });
      const response = await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      }) as { stackFrames?: unknown[] };
      assert.ok(response.stackFrames, 'stackTrace should succeed after stepIn');
    });

    it('stepOut returns success', async function () {
      await session.customRequest('stepOut', { threadId: 1 });
      const response = await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      }) as { stackFrames?: unknown[] };
      assert.ok(response.stackFrames, 'stackTrace should succeed after stepOut');
    });

    it('pause returns success', async function () {
      await session.customRequest('pause', { threadId: 1 });
      const response = await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      }) as { stackFrames?: unknown[] };
      assert.ok(response.stackFrames, 'stackTrace should succeed after pause');
    });

    it('restart returns success, session still active', async function () {
      let terminatedFired = false;
      const terminatedSub = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id === session.id) {
          terminatedFired = true;
        }
      });

      await session.customRequest('restart');

      // Give the mock time to process restart.
      await new Promise((r) => setTimeout(r, 200));
      terminatedSub.dispose();

      // Session should still be alive after restart.
      const response = await session.customRequest('stackTrace', {
        threadId: 1,
        startFrame: 0,
        levels: 1,
      }) as { stackFrames?: unknown[] };
      assert.ok(response.stackFrames, 'stackTrace should succeed after restart');
      assert.ok(!terminatedFired, 'terminated event should not fire on restart');
    });

    it('terminate fires terminated event', async function () {
      let terminatedFired = false;
      const terminatedPromise = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s.id === session.id) {
            terminatedFired = true;
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 5000);
      });

      await session.customRequest('terminate', {});

      await terminatedPromise;
      assert.strictEqual(terminatedFired, true,
        'onDidTerminateDebugSession should fire on terminate');
    });

    it('disconnect fires terminated event', async function () {
      let terminatedFired = false;
      const terminatedPromise = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s.id === session.id) {
            terminatedFired = true;
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 5000);
      });

      await session.customRequest('disconnect', {});

      await terminatedPromise;
      assert.strictEqual(terminatedFired, true,
        'onDidTerminateDebugSession should fire on disconnect');
    });

    it('setExceptionBreakpoints succeeds', async function () {
      const response = await session.customRequest('setExceptionBreakpoints', {
        filters: ['Notice', 'Warning'],
      });

      // The mock adapter returns an empty response {} for setExceptionBreakpoints.
      assert.ok(response !== undefined, 'setExceptionBreakpoints should return a response');
    });
  });

  // ── Path resolution ────────────────────────────────────────

  describe('Path Resolution', function () {
    it('resolves a path in the test workspace', async function () {
      const uri = await __resolveFileUriForTesting('index.php');
      assert.ok(uri.fsPath.includes('test-workspace'), `Expected fsPath to include test-workspace, got: ${uri.fsPath}`);
      assert.ok(uri.fsPath.endsWith('index.php'), `Expected fsPath to end with index.php, got: ${uri.fsPath}`);
    });

    it('returns a best-guess Uri for a path not in workspace', async function () {
      const uri = await __resolveFileUriForTesting('nonexistent-file.xyz');
      assert.ok(uri, 'Should return a Uri even for non-existent file');
      assert.ok(typeof uri.fsPath === 'string', 'fsPath should be a string');
    });
  });
});
