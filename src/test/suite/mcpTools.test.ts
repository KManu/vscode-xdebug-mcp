// src/test/suite/mcpTools.test.ts
// Phase 4: MCP Tool Integration Tests
//
// Tests every MCP tool, resource, and prompt via the HTTP transport.
// Uses the mock debug adapter (type: 'xdebug-mcp-test') registered in setup.ts.
//
// Each section:
//   beforeEach: start a mock debug session, wait for stopped state
//   Test: send HTTP POST to localhost:<port>/mcp for the specific tool
//   afterEach: disconnect session if still alive, wait for cleanup

import * as assert from 'assert';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { outputSchemas } from '../../mcp/server';

// ── Port resolution ──────────────────────────────────────────────

import { getServerPort } from '../helpers/portResolver';

// ── HTTP / JSON-RPC helpers ──────────────────────────────────────

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

/**
 * Initialize the MCP session and send the initialized notification.
 * Required before tools/list, prompts/list, resources/list, resources/templates/list.
 * Uses separate request IDs to avoid clashes.
 */
async function initializeMcp(port: number): Promise<void> {
  // Send initialize request.
  const initResp = await mcpRequest(
    port,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.0.0' },
    },
    99
  );
  assert.ok(initResp.result, `initialize should return result, got: ${JSON.stringify(initResp).slice(0, 200)}`);
  assert.ok(initResp.result.capabilities, 'initialize should include capabilities');

  // Send initialized notification.
  await mcpRequest(port, 'notifications/initialized', undefined, 98);
}

// ── Session management helpers ───────────────────────────────────

/**
 * Poll the MCP status tool until the active session reports stopped === true.
 */
async function pollUntilStopped(port: number, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await toolCall(port, 'status');
      const sc = resp.result?.structuredContent || resp.result || {};
      if (sc.status?.stopped === true) return;
    } catch {
      // Server may not be ready yet.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for session to stop after ${timeoutMs}ms`);
}

/**
 * Poll list_sessions until a specific session is no longer present
 * (terminated or disconnected).
 */
async function pollUntilSessionGone(port: number, sessionId: string, timeoutMs = 5000, intervalMs = 50): Promise<void> {
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

async function stopDebugSession(timeout = 5000): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    return;
  }

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
    // Session may already be terminated.
  }
}

// ── Test Suite ───────────────────────────────────────────────────

describe('MCP Tools', function () {
  this.timeout(30000);

  let port: number;
  let activeSession: vscode.DebugSession | undefined;

  before(async function () {
    const info = await getServerPort();
    port = info.port;
  });

  async function startDebugSession(): Promise<vscode.DebugSession> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder');
    }

    // Listen for onDidStartDebugSession BEFORE calling startDebugging.
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

    const started = await vscode.debug.startDebugging(folder, {
      type: 'xdebug-mcp-test',
      name: 'Test Session',
      request: 'launch',
    });

    assert.ok(started, 'startDebugging should return true');

    const session = await sessionPromise;
    assert.ok(session, 'Debug session should start');

    // Poll the MCP status tool until the session reports stopped.
    await pollUntilStopped(port, 5000, 50);

    return session;
  }

  // ── 4.1 Discovery ──────────────────────────────────────────

  describe('4.1 Discovery', function () {
    before(async function () {
      await initializeMcp(port);
    });

    it('tools/list returns all tools with inputSchema', async function () {
      const resp = await mcpRequest(port, 'tools/list');
      assert.ok(resp.result, 'tools/list should return result');
      assert.ok(Array.isArray(resp.result.tools), 'result.tools should be an array');
      assert.ok(resp.result.tools.length > 0, 'should have at least one tool');

      for (const tool of resp.result.tools) {
        assert.ok(tool.name, `tool should have a name, got: ${JSON.stringify(tool)}`);
        assert.ok(tool.inputSchema !== undefined, `tool ${tool.name} should have inputSchema`);
      }
    });

    it('spot-check inputSchema for stack, evaluate_expr, set_breakpoint', async function () {
      const resp = await mcpRequest(port, 'tools/list');
      const tools: Array<{ name: string; inputSchema: any }> = resp.result.tools;

      const stack = tools.find((t) => t.name === 'stack');
      assert.ok(stack, 'should have stack tool');
      assert.ok(stack.inputSchema, 'stack should have inputSchema');
      // Check that key properties exist in inputSchema.
      const stackProps = stack.inputSchema.properties || {};
      assert.ok(
        'sessionId' in stackProps || stack.inputSchema.type === 'object',
        'stack inputSchema should be an object'
      );

      const evaluate = tools.find((t) => t.name === 'evaluate_expr');
      assert.ok(evaluate, 'should have evaluate_expr tool');
      assert.ok(evaluate.inputSchema, 'evaluate_expr should have inputSchema');
      const evalProps = evaluate.inputSchema.properties || {};
      assert.ok('expr' in evalProps, 'evaluate_expr should accept expr parameter');

      const setBp = tools.find((t) => t.name === 'set_breakpoint');
      assert.ok(setBp, 'should have set_breakpoint tool');
      assert.ok(setBp.inputSchema, 'set_breakpoint should have inputSchema');
      const bpProps = setBp.inputSchema.properties || {};
      assert.ok('file' in bpProps, 'set_breakpoint should accept file parameter');
      assert.ok('breakpoints' in bpProps, 'set_breakpoint should accept breakpoints parameter');
    });

    it('prompts/list returns xdebug_mcp_capabilities', async function () {
      const resp = await mcpRequest(port, 'prompts/list');
      assert.ok(resp.result, 'prompts/list should return result');
      assert.ok(Array.isArray(resp.result.prompts), 'result.prompts should be an array');

      const capabilityPrompt = resp.result.prompts.find((p: any) => p.name === 'xdebug_mcp_capabilities');
      assert.ok(capabilityPrompt, 'should include xdebug_mcp_capabilities prompt');
      assert.ok(capabilityPrompt.title || capabilityPrompt.description, 'prompt should have title or description');
    });

    it('resources/list returns xdebug://stack', async function () {
      const resp = await mcpRequest(port, 'resources/list');
      assert.ok(resp.result, 'resources/list should return result');
      assert.ok(Array.isArray(resp.result.resources), 'result.resources should be an array');

      const stackResource = resp.result.resources.find((r: any) => r.uri === 'xdebug://stack');
      assert.ok(stackResource, 'should include xdebug://stack resource');
    });

    it('resources/templates/list returns xdebug://variables/{frameId} template', async function () {
      const resp = await mcpRequest(port, 'resources/templates/list');
      assert.ok(resp.result, 'resources/templates/list should return result');
      assert.ok(Array.isArray(resp.result.resourceTemplates), 'result.resourceTemplates should be an array');

      const varTemplate = resp.result.resourceTemplates.find(
        (rt: any) => rt.uriTemplate === 'xdebug://variables/{frameId}' || rt.name === 'Frame Variables'
      );
      assert.ok(varTemplate, 'should include variables resource template');
    });
  });

  // ── 4.2 Read-only inspection tools ──────────────────────────

  describe('4.2 Read-only inspection tools', function () {
    let sessionId: string;

    beforeEach(async function () {
      activeSession = await startDebugSession();
      sessionId = activeSession.id;
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    it('stack: returns frames with id, name, source, line', async function () {
      const resp = await toolCall(port, 'stack');
      assert.ok(resp.result, `stack should return result, got: ${JSON.stringify(resp).slice(0, 200)}`);
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'stack should have success: true');
      assert.ok(Array.isArray(sc.frames), 'should return frames array');
      assert.ok(sc.frames.length > 0, 'should have at least one frame');

      const frame = sc.frames[0];
      assert.strictEqual(typeof frame.id, 'number', 'frame should have numeric id');
      assert.strictEqual(typeof frame.name, 'string', 'frame should have name');
      assert.ok(frame.source, 'frame should have a source');
      if (frame.source) {
        assert.strictEqual(typeof (frame.source as any).name, 'string', 'source should have name');
        assert.strictEqual(typeof (frame.source as any).path, 'string', 'source should have path');
      }
      assert.strictEqual(typeof frame.line, 'number', 'frame should have numeric line');
    });

    it('stack: with explicit sessionId', async function () {
      const resp = await toolCall(port, 'stack', { sessionId });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'stack with explicit sessionId should succeed');
      assert.ok(Array.isArray(sc.frames), 'should return frames');
    });

    it('scopes: returns scopes with variablesReference', async function () {
      // First get the top frame id.
      const stackResp = await toolCall(port, 'stack');
      const stackSc = stackResp.result.structuredContent || stackResp.result;
      const frameId = stackSc.frames[0].id;

      const resp = await toolCall(port, 'scopes', { frameId });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'scopes should succeed');
      assert.ok(Array.isArray(sc.scopes), 'should return scopes array');
      assert.ok(sc.scopes.length > 0, 'should have at least one scope');

      const scope = sc.scopes[0];
      assert.strictEqual(typeof scope.name, 'string', 'scope should have name');
      assert.strictEqual(typeof scope.variablesReference, 'number', 'scope should have variablesReference');
    });

    it('variables: chain scopes→variables', async function () {
      // Get frame → scopes → variables reference.
      const stackResp = await toolCall(port, 'stack');
      const stackSc = stackResp.result.structuredContent || stackResp.result;
      const frameId = stackSc.frames[0].id;

      const scopesResp = await toolCall(port, 'scopes', { frameId });
      const scopesSc = scopesResp.result.structuredContent || scopesResp.result;
      const variablesReference = scopesSc.scopes[0].variablesReference;

      const resp = await toolCall(port, 'variables', { variablesReference });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'variables should succeed');
      assert.ok(Array.isArray(sc.variables), 'should return variables array');
      assert.ok(sc.variables.length > 0, 'should have at least one variable');

      const variable = sc.variables[0];
      assert.strictEqual(typeof variable.name, 'string', 'variable should have name');
      assert.strictEqual(typeof variable.value, 'string', 'variable should have value');
    });

    it('variables: with invalid variablesReference (99999) → error', async function () {
      const resp = await toolCall(port, 'variables', { variablesReference: 99999 });
      const sc = resp.result.structuredContent || resp.result;
      // The mock returns an error for unknown references.
      assert.strictEqual(sc.success, false, 'should fail for invalid variablesReference');
      assert.ok(sc.error, 'should include error message');
    });

    it('threads: returns thread list', async function () {
      const resp = await toolCall(port, 'threads');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'threads should succeed');
      assert.ok(Array.isArray(sc.threads), 'should return threads array');
      assert.ok(sc.threads.length > 0, 'should have at least one thread');

      const thread = sc.threads[0];
      assert.strictEqual(typeof thread.id, 'number', 'thread should have numeric id');
      assert.strictEqual(typeof thread.name, 'string', 'thread should have name');
    });

    it('snapshot: returns aggregated response with frame, scopes, variables', async function () {
      const resp = await toolCall(port, 'snapshot', { threadId: 1 });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'snapshot should succeed');

      // Should include a frame.
      assert.ok(sc.frame, 'snapshot should include frame');
      assert.strictEqual(typeof sc.frame.id, 'number', 'frame should have id');

      // Should include scopes with variables.
      assert.ok(Array.isArray(sc.scopes), 'snapshot should include scopes array');
      if (sc.scopes.length > 0) {
        const scopeEntry = sc.scopes[0];
        assert.ok(scopeEntry.scope, 'scope entry should have scope object');
        assert.ok(Array.isArray(scopeEntry.variables), 'scope entry should have variables array');
      }
    });

    it('status: verify status.stopped is true, status.session has fields', async function () {
      const resp = await toolCall(port, 'status');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'status should succeed');

      // stopped is a boolean, not a string.
      assert.strictEqual(sc.status.stopped, true, 'status.stopped should be true (boolean)');
      assert.ok(sc.status.session, 'status should have session info');
      assert.strictEqual(typeof sc.status.session.id, 'string', 'session.id should be a string');
      assert.strictEqual(typeof sc.status.session.name, 'string', 'session.name should be a string');
      assert.strictEqual(typeof sc.status.session.type, 'string', 'session.type should be a string');
    });

    it('diagnostics: returns recommendations and sessions', async function () {
      const resp = await toolCall(port, 'diagnostics');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'diagnostics should succeed');
      assert.strictEqual(sc.server, 'running', 'diagnostics should report server running');
      assert.ok(Array.isArray(sc.recommendations), 'diagnostics should have recommendations');
      assert.ok(Array.isArray(sc.sessions), 'diagnostics should have sessions array');
      assert.strictEqual(sc.sessionCount, sc.sessions.length, 'sessionCount should match sessions length');
    });

    it('list_sessions: returns active mock session', async function () {
      const resp = await toolCall(port, 'list_sessions');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'list_sessions should succeed');
      assert.ok(Array.isArray(sc.sessions), 'should return sessions array');
      assert.ok(sc.sessions.length > 0, 'should have at least one session');

      const found = sc.sessions.some((s: any) => s.id === sessionId);
      assert.ok(found, `session ${sessionId} should be in list_sessions`);
    });
  });

  // ── 4.3 Breakpoint tools ────────────────────────────────────

  describe('4.3 Breakpoint tools', function () {
    beforeEach(async function () {
      activeSession = await startDebugSession();
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    it('set_breakpoint: set file breakpoint, verify verified with line and id', async function () {
      const resp = await toolCall(port, 'set_breakpoint', {
        file: 'index.php',
        breakpoints: [{ line: 10 }],
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'set_breakpoint should succeed');
      assert.ok(Array.isArray(sc.results), 'should return results array');
      assert.ok(sc.results.length > 0, 'should have at least one result');
      assert.strictEqual(sc.results[0].verified, true, 'breakpoint should be verified');
    });

    it('set_breakpoint: invalid location → error', async function () {
      // An empty file path should cause a resolution error.
      // The error may come back as a top-level JSON-RPC error or nested in result.
      const resp = await toolCall(port, 'set_breakpoint', {
        file: '',
        breakpoints: [{ line: 1 }],
      });
      if (resp.error) {
        // Top-level JSON-RPC error (MCP SDK translates handler exceptions).
        assert.ok(resp.error.message || resp.error.code, 'should include error message or code');
      } else {
        const sc = resp.result.structuredContent || resp.result;
        assert.strictEqual(sc.success, false, 'set_breakpoint with empty file should fail');
        assert.ok(sc.error, 'should include error message');
      }
    });

    it('set_function_breakpoints: verified with name', async function () {
      const resp = await toolCall(port, 'set_function_breakpoints', {
        breakpoints: [{ name: 'myFunction' }],
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'set_function_breakpoints should succeed');
      assert.ok(Array.isArray(sc.results), 'should return results array');
      assert.ok(sc.results.length > 0, 'should have at least one result');
    });

    it('set_exception_breakpoints: success', async function () {
      const resp = await toolCall(port, 'set_exception_breakpoints', {
        filters: ['Notice', 'Warning'],
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'set_exception_breakpoints should succeed');
      assert.ok(Array.isArray(sc.results), 'should return results array');
    });

    it('set_logpoint: includes logMessage', async function () {
      const resp = await toolCall(port, 'set_logpoint', {
        file: 'index.php',
        logpoints: [{ line: 5, logMessage: 'Test log {variable}' }],
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'set_logpoint should succeed');
      assert.ok(Array.isArray(sc.results), 'should return results array');
      assert.ok(sc.results.length > 0, 'should have at least one result');
      assert.strictEqual(sc.results[0].verified, true, 'logpoint should be verified');
    });

    it('clear_breakpoints: set several, clear all, verify fresh set_breakpoint', async function () {
      // Set a breakpoint first.
      await toolCall(port, 'set_breakpoint', {
        file: 'index.php',
        breakpoints: [{ line: 10 }, { line: 20 }],
      });

      // Clear all breakpoints for the file.
      const clearResp = await toolCall(port, 'clear_breakpoints', {
        file: 'index.php',
      });
      const clearSc = clearResp.result.structuredContent || clearResp.result;
      assert.strictEqual(clearSc.success, true, 'clear_breakpoints should succeed');

      // Set a fresh breakpoint — should work without issue.
      const resp = await toolCall(port, 'set_breakpoint', {
        file: 'index.php',
        breakpoints: [{ line: 15 }],
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'set_breakpoint after clear should succeed');
      assert.strictEqual(sc.results[0].verified, true, 'fresh breakpoint should be verified');
    });
  });

  // ── 4.4 Execution control tools ─────────────────────────────

  describe('4.4 Execution control tools', function () {
    beforeEach(async function () {
      activeSession = await startDebugSession();
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    it('continue: returns okResult, session still listed (not auto-terminated)', async function () {
      const resp = await toolCall(port, 'continue');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'continue should return success');

      // After Fix 1, continue does NOT auto-terminate the session.
      // The session should still be in list_sessions.
      const listResp = await toolCall(port, 'list_sessions');
      const listSc = listResp.result.structuredContent || listResp.result;
      const found = listSc.sessions.some((s: any) => s.id === activeSession!.id);
      assert.strictEqual(found, true, 'session should still be in list_sessions after continue');
    });

    it('step_over: mock fires stopped, verify status.stopped is true', async function () {
      const resp = await toolCall(port, 'step_over');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'step_over should return success');

      await pollUntilStopped(port, 5000, 50);

      const statusResp = await toolCall(port, 'status');
      const statusSc = statusResp.result.structuredContent || statusResp.result;
      assert.strictEqual(statusSc.status.stopped, true, 'status.stopped should be true after step_over');
    });

    it('step_in: mock fires stopped, verify status.stopped is true', async function () {
      const resp = await toolCall(port, 'step_in');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'step_in should return success');

      await pollUntilStopped(port, 5000, 50);

      const statusResp = await toolCall(port, 'status');
      const statusSc = statusResp.result.structuredContent || statusResp.result;
      assert.strictEqual(statusSc.status.stopped, true, 'status.stopped should be true after step_in');
    });

    it('step_out: mock fires stopped, verify status.stopped is true', async function () {
      const resp = await toolCall(port, 'step_out');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'step_out should return success');

      await pollUntilStopped(port, 5000, 50);

      const statusResp = await toolCall(port, 'status');
      const statusSc = statusResp.result.structuredContent || statusResp.result;
      assert.strictEqual(statusSc.status.stopped, true, 'status.stopped should be true after step_out');
    });

    it('pause: mock fires stopped (reason:pause), verify status.stopped is true', async function () {
      const resp = await toolCall(port, 'pause');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'pause should return success');

      await pollUntilStopped(port, 5000, 50);

      const statusResp = await toolCall(port, 'status');
      const statusSc = statusResp.result.structuredContent || statusResp.result;
      assert.strictEqual(statusSc.status.stopped, true, 'status.stopped should be true after pause');
    });

    it('restart: mock fires stopped (no terminated), session still in list_sessions', async function () {
      const resp = await toolCall(port, 'restart');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'restart should return success');

      await pollUntilStopped(port, 5000, 50);

      // Session should still be listed.
      const listResp = await toolCall(port, 'list_sessions');
      const listSc = listResp.result.structuredContent || listResp.result;
      assert.ok(listSc.sessions.length > 0, 'should have sessions after restart');

      // Status should show stopped.
      const statusResp = await toolCall(port, 'status');
      const statusSc = statusResp.result.structuredContent || statusResp.result;
      assert.strictEqual(statusSc.status.stopped, true, 'status.stopped should be true after restart');
    });

    it('terminate: returns okResult, session removed from list_sessions', async function () {
      const resp = await toolCall(port, 'terminate');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'terminate should return success');

      await pollUntilSessionGone(port, activeSession!.id, 5000, 50);

      const listResp = await toolCall(port, 'list_sessions');
      const listSc = listResp.result.structuredContent || listResp.result;
      const found = listSc.sessions.some((s: any) => s.id === activeSession!.id);
      assert.strictEqual(found, false, 'session should not be in list_sessions after terminate');
    });

    it('disconnect: returns okResult, session removed from list_sessions', async function () {
      const resp = await toolCall(port, 'disconnect');
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'disconnect should return success');

      await pollUntilSessionGone(port, activeSession!.id, 5000, 50);

      const listResp = await toolCall(port, 'list_sessions');
      const listSc = listResp.result.structuredContent || listResp.result;
      const found = listSc.sessions.some((s: any) => s.id === activeSession!.id);
      assert.strictEqual(found, false, 'session should not be in list_sessions after disconnect');
    });

    it('wait_for_stop: poll until stopped, response includes stopped:true', async function () {
      // Start a new session — wait_for_stop should detect it's already stopped.
      const resp = await toolCall(port, 'wait_for_stop', { pollMs: 50, timeoutMs: 5000 });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'wait_for_stop should succeed');
      assert.strictEqual(sc.stopped, true, 'wait_for_stop should return stopped: true');
      assert.ok(sc.frame, 'wait_for_stop should include frame');
    });
  });

  // ── 4.5 Evaluation tools ─────────────────────────────────────

  describe('4.5 Evaluation tools', function () {
    beforeEach(async function () {
      activeSession = await startDebugSession();
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    it('evaluate_expr: {expr:"1 + 2"} → result "3"', async function () {
      const resp = await toolCall(port, 'evaluate_expr', { expr: '1 + 2' });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'evaluate_expr should succeed');
      // The mock uses eval(), so '1 + 2' evaluates to 3.
      assert.strictEqual(sc.result, '3', '1 + 2 should evaluate to "3"');
    });

    it('evaluate_expr: with frameId:0', async function () {
      const resp = await toolCall(port, 'evaluate_expr', { expr: '42', frameId: 0 });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'evaluate_expr with frameId should succeed');
      assert.strictEqual(sc.result, '42', 'should evaluate to "42"');
    });

    it('evaluate_expr: with context:"watch"', async function () {
      const resp = await toolCall(port, 'evaluate_expr', {
        expr: '100',
        context: 'watch',
      });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'evaluate_expr with context watch should succeed');
      // The mock prepends "[watch] " for watch context.
      assert.ok(
        sc.result.includes('watch') || sc.result === '[watch] 100',
        `result should indicate watch context, got: ${sc.result}`
      );
    });

    it('evaluate_expr: without frameId (implicit stack→top-frame resolution)', async function () {
      const resp = await toolCall(port, 'evaluate_expr', { expr: 'typeof 1' });
      const sc = resp.result.structuredContent || resp.result;
      assert.strictEqual(sc.success, true, 'evaluate_expr without frameId should succeed');
      assert.ok(typeof sc.result === 'string', 'result should be a string');
    });
  });

  // ── 4.6 Resource handlers ────────────────────────────────────

  describe('4.6 Resource handlers', function () {
    beforeEach(async function () {
      activeSession = await startDebugSession();
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    it('resources/read with uri:xdebug://stack → returns stack frames', async function () {
      const resp = await mcpRequest(port, 'resources/read', { uri: 'xdebug://stack' });
      assert.ok(resp.result, 'resources/read should return result');
      // The response content contains the stack frames as a text.
      assert.ok(Array.isArray(resp.result.contents), 'should have contents array');
      assert.ok(resp.result.contents.length > 0, 'should have at least one content entry');

      const text = resp.result.contents[0].text;
      assert.ok(text, 'should have text content');
      const parsed = JSON.parse(text);
      assert.ok(Array.isArray(parsed), 'stack should be parsed as array');
      assert.ok(parsed.length > 0, 'should have at least one frame');
      assert.strictEqual(typeof parsed[0].id, 'number', 'frame should have numeric id');
    });

    it('resources/read with xdebug://variables/0 → returns variables', async function () {
      const resp = await mcpRequest(port, 'resources/read', {
        uri: 'xdebug://variables/0',
      });
      assert.ok(resp.result, 'resources/read for variables should return result');
      assert.ok(Array.isArray(resp.result.contents), 'should have contents array');
      assert.ok(resp.result.contents.length > 0, 'should have at least one content entry');

      const text = resp.result.contents[0].text;
      assert.ok(text, 'should have text content');
      const parsed = JSON.parse(text);
      assert.ok(Array.isArray(parsed), 'variables should be parsed as array');
    });

    it('resources/read with invalid frameId → error', async function () {
      const resp = await mcpRequest(port, 'resources/read', {
        uri: 'xdebug://variables/abc',
      });
      // Should return an error.
      assert.ok(resp.error, 'should return error for invalid frameId');
      assert.ok(resp.error.message || resp.error.code, 'error should have message or code');
    });
  });

  // ── 4.7 Session lifecycle ────────────────────────────────────

  describe('4.7 Session lifecycle', function () {
    it('after continue, session is alive and accessible', async function () {
      const session = await startDebugSession();

      await toolCall(port, 'continue');

      // Session should still be in list_sessions (not removed by continue).
      const listResp = await toolCall(port, 'list_sessions');
      const listSc = listResp.result.structuredContent || listResp.result;
      const found = listSc.sessions.some((s: any) => s.id === session.id);
      assert.strictEqual(
        found,
        true,
        'session should still be in list_sessions after continue (Fix 1: no auto-terminate)'
      );

      // Stack should still work — mock always returns frames regardless of running state.
      const stackResp = await toolCall(port, 'stack');
      const stackSc = stackResp.result.structuredContent || stackResp.result;
      assert.strictEqual(stackSc.success, true, 'stack should succeed after continue (session is alive)');
      assert.ok(Array.isArray(stackSc.frames), 'should return frames');
      assert.ok(stackSc.frames.length > 0, 'should have at least one frame');

      // Cleanup: terminate since session is still alive.
      await toolCall(port, 'terminate');
      activeSession = undefined;
      await stopDebugSession().catch(() => undefined);
    });
  });

  // ── 4.8 Output schema validation ─────────────────────────────

  describe('4.8 Output schema validation', function () {
    let sessionId: string;

    // Map of tool name → Zod output schema from server.ts (single source of truth).
    const toolSchemas: Record<string, { schema: any; args: any; setup?: () => Promise<any> }> = {
      set_breakpoint: {
        schema: outputSchemas.setBreakpoint,
        args: { file: 'index.php', breakpoints: [{ line: 5 }] },
      },
      set_logpoint: {
        schema: outputSchemas.setLogpoint,
        args: { file: 'index.php', logpoints: [{ line: 5, logMessage: 'test' }] },
      },
      status: {
        schema: outputSchemas.status,
        args: {},
      },
      stack: {
        schema: outputSchemas.stack,
        args: {},
      },
      scopes: {
        schema: outputSchemas.scopes,
        args: { frameId: 0 },
      },
      variables: {
        schema: outputSchemas.variables,
        args: { variablesReference: 100 },
      },
      wait_for_stop: {
        schema: outputSchemas.waitForStop,
        args: { pollMs: 50, timeoutMs: 5000 },
      },
      list_sessions: {
        schema: outputSchemas.listSessions,
        args: {},
      },
    };

    beforeEach(async function () {
      activeSession = await startDebugSession();
      sessionId = activeSession.id;
    });

    afterEach(async function () {
      try {
        await stopDebugSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes('not found') &&
          !msg.includes('No active') &&
          !msg.includes('terminated') &&
          !msg.includes('disconnect')
        ) {
          console.warn(`[afterEach cleanup] Unexpected error: ${msg}`);
        }
      }
      activeSession = undefined;
    });

    // Iterate over known tools with schemas and validate structuredContent.
    for (const [toolName, { schema, args, setup }] of Object.entries(toolSchemas)) {
      it(`outputSchema for "${toolName}" passes .parse()`, async function () {
        // Run any setup needed (e.g., resolve scopes → frameId).
        if (setup) {
          await setup();
        }

        const resp = await toolCall(port, toolName, args);
        const sc = resp.result.structuredContent || resp.result;

        // Parse and validate. This throws on failure.
        const parsed = schema.parse(sc);
        assert.ok(parsed, `structuredContent for ${toolName} should pass schema validation`);
        assert.strictEqual(parsed.success, true, `${toolName} should have success: true`);
      });
    }
  });
});
