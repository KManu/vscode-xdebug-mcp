import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import { createMockDebugSession, createMockWorkspaceFolder } from './mockVscode';

// vscode mock is configured globally in src/__tests__/setup.ts

// Import after mocking
import * as dapBridge from '../debug/dapBridge';
import * as vscode from 'vscode';

// Type-cast wrapper: MockDebugSession → vscode.DebugSession
function mockSession(overrides?: Parameters<typeof createMockDebugSession>[0]) {
  return createMockDebugSession(overrides) as unknown as vscode.DebugSession;
}

describe('dapBridge error detection (isNotStoppedError)', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  /**
   * isNotStoppedError() determines if a DAP error is a "not stopped" polling error
   * that should be swallowed vs a fatal error that should propagate.
   *
   * We test this via status() behavior since isNotStoppedError is private:
   * - If stackTrace throws a "notStopped" error, status() returns { stopped: false }
   * - If stackTrace throws other errors, status() propagates them
   */

  // Test case 1: Error message contains "notStopped" -> isNotStoppedError returns true -> status returns stopped:false
  it('should return stopped:false when stackTrace throws error with "notStopped" in message', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        throw new Error('Debugger notStopped error');
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });

  // Test case 2: body.error.id === 'notStopped' -> isNotStoppedError returns true -> status returns stopped:false
  it('should return stopped:false when stackTrace throws error with body.error.id === "notStopped"', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        const error = new Error('Some error');
        (error as any).body = { error: { id: 'notStopped' } };
        throw error;
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });

  // Test case 3: Both message has "notStopped" AND body has the id -> isNotStoppedError returns true
  it('should return stopped:false when error has both "notStopped" in message and body.error.id', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        const error = new Error('notStopped');
        (error as any).body = { error: { id: 'notStopped' } };
        throw error;
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });

  // Test case 4: Other error messages -> isNotStoppedError returns false -> error propagates
  it('should propagate non-notStopped errors from stackTrace', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        throw new Error('Some other error');
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    await expect(dapBridge.status('session-1')).rejects.toThrow('Some other error');
  });

  // Test case 5: Error with no body (but message contains "notStopped") -> isNotStoppedError returns true
  it('should return stopped:false when error message contains "notStopped" but has no body', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        throw new Error('notStopped');
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });

  // Test case 6: Error with body but no error.id -> isNotStoppedError returns false (unless message matches)
  it('should propagate error when body exists but error.id is missing', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        const error = new Error('notStopped');
        (error as any).body = { error: {} }; // no id field
        throw error;
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    // Since message includes "notStopped", it should still return stopped: false
    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });

  // Test case 7: Error with body.error.id but not "notStopped" -> only body check applies
  it('should return stopped:false when body.error.id is "notStopped" regardless of message', async () => {
    const session = mockSession({ id: 'session-1' });
    session.customRequest = vi.fn().mockImplementation((command: string) => {
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1, name: 'Thread 1' }] });
      }
      if (command === 'stackTrace') {
        const error = new Error('Different error message');
        (error as any).body = { error: { id: 'notStopped' } };
        throw error;
      }
      return Promise.resolve({});
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.status('session-1');
    expect(result.stopped).toBe(false);
  });
});

describe('dapBridge session resolution', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    dapBridge.__clearSessionsForTesting();
    // Reset activeDebugSession
    vscode.debug.activeDebugSession = undefined;
  });

  describe('getSession', () => {
    // Test case 1: Valid sessionId returns that session from registry
    it('should return session when valid sessionId is provided', async () => {
      const session = mockSession({ id: 'session-1', name: 'PHP Session 1' });
      dapBridge.__addSessionForTesting(session);

      const status = await dapBridge.status('session-1');
      expect(status.session.id).toBe('session-1');
      expect(status.session.name).toBe('PHP Session 1');
    });

    // Test case 2: Invalid sessionId throws error
    it('should throw when sessionId is not found in registry', async () => {
      await expect(dapBridge.status('nonexistent')).rejects.toThrow('Debug session not found: nonexistent');
    });

    // Test case 3: No sessionId + active session exists returns active session
    it('should return activeDebugSession when no sessionId provided and active session exists', async () => {
      const activeSession = mockSession({ id: 'active-session', name: 'Active PHP Session' });
      // Add to registry AND set as active
      dapBridge.__addSessionForTesting(activeSession);
      vscode.debug.activeDebugSession = activeSession;

      const status = await dapBridge.status();
      expect(status.session.id).toBe('active-session');
    });

    // Test case 4: No sessionId + no active session throws error
    it('should throw when no sessionId and no activeDebugSession', async () => {
      vscode.debug.activeDebugSession = undefined;

      await expect(dapBridge.status()).rejects.toThrow('No active debug session');
    });
  });
});

describe('dapBridge path resolution (resolveFileUri via setFileBreakpoints)', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    dapBridge.registerSessionTracking([]);
    vscode.debug.activeDebugSession = undefined;
    // Reset workspace folders
    // Reset workspace folders using Object.defineProperty to bypass readonly
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    // Reset fs.stat mock to succeed by default
    (vscode.workspace.fs.stat as any).mockResolvedValue({});
    // Clear mock call counts
    vi.clearAllMocks();
  });

  describe('setFileBreakpoints path resolution', () => {
    // Test case 2: Absolute Unix path -> Uri.file() result
    it('should call Uri.file for absolute Unix paths', async () => {
      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: '/var/www/html/index.php',
        breakpoints: [{ line: 10 }],
      });

      expect(vscode.Uri.file).toHaveBeenCalledWith('/var/www/html/index.php');
    });

    // Test case 3: Windows drive path -> Uri.file() result
    it('should call Uri.file for Windows drive paths', async () => {
      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'C:\\path\\to\\file.php',
        breakpoints: [{ line: 10 }],
      });

      expect(vscode.Uri.file).toHaveBeenCalledWith('C:\\path\\to\\file.php');
    });

    // Test case 4: Workspace-relative path -> resolved against first workspace folder
    it('should resolve workspace-relative paths against first workspace folder', async () => {
      const folder1 = createMockWorkspaceFolder('/workspace/project1');
      const folder2 = createMockWorkspaceFolder('/workspace/project2');
      // Use Object.defineProperty to set workspaceFolders (bypasses readonly)
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder1, folder2],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'src/index.php',
        breakpoints: [{ line: 10 }],
      });

      // Uri.joinPath should be called with the first folder's uri
      expect(vscode.Uri.joinPath).toHaveBeenCalledWith(folder1.uri, 'src/index.php');
    });

    // Test case 5: Relative path not in first folder -> searched in subsequent folders
    it('should search for relative paths in subsequent folders when not in first folder', async () => {
      const folder1 = createMockWorkspaceFolder('/workspace/project1');
      const folder2 = createMockWorkspaceFolder('/workspace/project2');

      // Mock fs.stat to succeed only for folder2
      (vscode.workspace.fs.stat as any).mockImplementation(async (uri: any) => {
        if (uri.fsPath.startsWith('/workspace/project2')) {
          return {};
        }
        const err = new Error('ENOENT') as any;
        err.code = 'ENOENT';
        throw err;
      });

      // Use Object.defineProperty to set workspaceFolders (bypasses readonly)
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder1, folder2],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'shared/util.php',
        breakpoints: [{ line: 10 }],
      });

      // Should have searched in folder1 first (joinPath was called), found file missing (stat failed), then searched in folder2
      // The implementation falls back to firstFolder.joinPath(relative) if file doesn't exist anywhere
      // But since folder2 file exists, it should return folder2's joinPath result
      expect(vscode.Uri.joinPath).toHaveBeenCalled();
    });

    // Test case 6: Non-existent relative path -> returned as firstFolder.joinPath(relative)
    it('should return firstFolder.joinPath(relative) when relative path does not exist', async () => {
      const folder1 = createMockWorkspaceFolder('/workspace/project1');
      // Use Object.defineProperty to set workspaceFolders (bypasses readonly)
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder1],
        writable: true,
        configurable: true,
      });

      // Mock fs.stat to always fail (file doesn't exist)
      const notFoundErr = new Error('ENOENT') as any;
      notFoundErr.code = 'ENOENT';
      (vscode.workspace.fs.stat as any).mockRejectedValue(notFoundErr);

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'nonexistent.php',
        breakpoints: [{ line: 10 }],
      });

      // Since file doesn't exist in any folder, it should fall back to firstFolder.joinPath(relative)
      expect(vscode.Uri.joinPath).toHaveBeenCalledWith(folder1.uri, 'nonexistent.php');
    });

    // Test case 1 variant: URI string input -> Uri.parse() result
    it('should call Uri.parse for URI strings', async () => {
      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'file:///var/www/html/index.php',
        breakpoints: [{ line: 10 }],
      });

      expect(vscode.Uri.parse).toHaveBeenCalledWith('file:///var/www/html/index.php');
    });
  });
});

describe('dapBridge breakpoint lifecycle', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    dapBridge.__clearBreakpointsForTesting();
    dapBridge.registerSessionTracking([]);
    vscode.debug.activeDebugSession = undefined;
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    (vscode.workspace.fs.stat as any).mockResolvedValue({});
    vi.clearAllMocks();
  });

  describe('setFileBreakpoints', () => {
    // 1. Set breakpoints on new file -> added to mcpFileBreakpoints Map
    it('should add breakpoints to mcpFileBreakpoints Map for new file', async () => {
      const folder = createMockWorkspaceFolder('/workspace/project');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }, { line: 20 }],
      });

      const breakpoints = dapBridge.__getFileBreakpointsForTesting();
      expect(breakpoints.size).toBe(1);
      const key = Array.from(breakpoints.keys())[0];
      expect(key).toContain('/workspace/project/src/index.php');
    });

    // 2. Re-set breakpoints on same file -> old removed before new added
    it('should remove old breakpoints before adding new ones for the same file', async () => {
      const folder = createMockWorkspaceFolder('/workspace/project');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      // Set initial breakpoints
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }],
      });

      // Verify removeBreakpoints was called once (to remove old ones before adding new)
      const removeCallCountAfterFirst = (vscode.debug.removeBreakpoints as any).mock.calls.length;

      // Reset breakpoints on same file
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 20 }, { line: 30 }],
      });

      // removeBreakpoints should have been called again when resetting
      expect((vscode.debug.removeBreakpoints as any).mock.calls.length).toBeGreaterThan(removeCallCountAfterFirst);
      expect(vscode.debug.removeBreakpoints).toHaveBeenCalled();
    });

    // 3. Clear breakpoints (empty array) -> removed from registry
    it('should remove breakpoints from registry when array is empty', async () => {
      const folder = createMockWorkspaceFolder('/workspace/project');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      // Set initial breakpoints
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }],
      });

      let breakpoints = dapBridge.__getFileBreakpointsForTesting();
      expect(breakpoints.size).toBe(1);

      // Clear breakpoints via clearFileBreakpoints
      await dapBridge.clearFileBreakpoints({
        file: '/workspace/project/src/index.php',
      });

      breakpoints = dapBridge.__getFileBreakpointsForTesting();
      expect(breakpoints.size).toBe(0);
    });

    // 4. SourceModified flag -> passed through (verifying addBreakpoints was called)
    it('should call addBreakpoints when setting breakpoints', async () => {
      const folder = createMockWorkspaceFolder('/workspace/project');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        value: [folder],
        writable: true,
        configurable: true,
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }],
        sourceModified: true,
      });

      // verify addBreakpoints was called
      expect(vscode.debug.addBreakpoints).toHaveBeenCalled();
      const addedBreakpoints = (vscode.debug.addBreakpoints as any).mock.calls[0][0];
      expect(addedBreakpoints.length).toBe(1);
    });
  });

  describe('setFunctionBreakpoints', () => {
    // 1. Set function breakpoints -> stored in mcpFunctionBreakpoints array
    it('should store function breakpoints in mcpFunctionBreakpoints array', async () => {
      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFunctionBreakpoints({
        breakpoints: [{ name: 'myFunction' }, { name: 'anotherFunction' }],
      });

      const funcs = dapBridge.__getFunctionBreakpointsForTesting();
      expect(funcs.length).toBe(2);
    });

    // 2. Replace function breakpoints -> old replaced with new
    it('should replace old function breakpoints when setting new ones', async () => {
      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      // Set initial function breakpoints
      await dapBridge.setFunctionBreakpoints({
        breakpoints: [{ name: 'oldFunction' }],
      });

      let funcs = dapBridge.__getFunctionBreakpointsForTesting();
      expect(funcs.length).toBe(1);

      // Replace with new function breakpoints
      await dapBridge.setFunctionBreakpoints({
        breakpoints: [{ name: 'newFunction1' }, { name: 'newFunction2' }],
      });

      funcs = dapBridge.__getFunctionBreakpointsForTesting();
      expect(funcs.length).toBe(2);
      // Verify removeBreakpoints was called to remove old ones
      expect(vscode.debug.removeBreakpoints).toHaveBeenCalled();
    });
  });

  describe('setExceptionBreakpoints', () => {
    // Set exception breakpoints -> forwarded to DAP adapter via session.customRequest
    it('should forward exception breakpoints to DAP adapter via customRequest', async () => {
      const session = mockSession({ id: 'session-1' });
      session.customRequest = vi.fn().mockResolvedValue({ breakpoints: [] });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setExceptionBreakpoints({
        filters: ['AllExceptions', 'UnhandledExceptions'],
      });

      expect(session.customRequest).toHaveBeenCalledWith('setExceptionBreakpoints', {
        filters: ['AllExceptions', 'UnhandledExceptions'],
        exceptionOptions: undefined,
      });
    });
  });
});

describe('dapBridge stepOut depth-based auto-repeat', () => {
  beforeEach(() => {
    dapBridge.__clearSessionsForTesting();
    vscode.debug.activeDebugSession = undefined;
    vi.clearAllMocks();
  });

  const mkFrame = (name: string, line: number, id: number) => ({
    id,
    name,
    line,
    source: { path: name === '{main}' ? '/app/test.php' : '/app/lib.php' },
  });

  type Frame = ReturnType<typeof mkFrame>;

  // Scripted session: each stackTrace call consumes the next frame set from
  // the queue (last entry repeats). Returns call inspectors for assertions.
  function makeScriptedSession(stacks: Frame[][]) {
    const session = mockSession({ id: 'step-session' });
    let stackCalls = 0;
    session.customRequest = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'stackTrace') {
        const frames = stacks[Math.min(stackCalls, stacks.length - 1)];
        stackCalls += 1;
        return { stackFrames: frames };
      }
      if (command === 'stepOut') {
        return {};
      }
      if (command === 'threads') {
        return { threads: [{ id: 7 }] };
      }
      return {};
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;
    const calls = (command: string) =>
      (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[0] === command);
    return { session, calls };
  }

  it('clean adapter: exits after a single stepOut (regression guard)', async () => {
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 13, 2)];
    const after = [mkFrame('{main}', 13, 3)];
    const { calls } = makeScriptedSession([base, after]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(1);
    expect(result.frame).toEqual(after[0]);
  });

  it('Xdebug quirk (Repro A — already at return line): re-steps and exits', async () => {
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    const { calls } = makeScriptedSession([base, base, [mkFrame('{main}', 13, 3)]]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(2);
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(1);
    expect(result.frame?.line).toBe(13);
  });

  it('Xdebug quirk (Repro B — mid-function): line moves then exits', async () => {
    const base = [mkFrame('greet', 7, 1), mkFrame('{main}', 17, 2)];
    const { calls } = makeScriptedSession([
      base,
      [mkFrame('greet', 8, 4), mkFrame('{main}', 17, 2)],
      [mkFrame('{main}', 18, 5)],
    ]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(2);
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.frame?.name).toBe('{main}');
    expect(result.frame?.line).toBe(18);
  });

  it('{main} top frame: single shot, no wait-for-stop polling', async () => {
    const mainFrame = mkFrame('{main}', 12, 1);
    const { calls } = makeScriptedSession([[mainFrame]]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(calls('stackTrace').length).toBe(1); // baseline only, no polling
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(1);
    expect(result.frame).toEqual(mainFrame);
    expect(result.message).toContain('returned immediately without waiting for exit');
  });

  it('top-level frame with a non-{main} name: still a single shot (depth <= 1)', async () => {
    const topFrame = mkFrame('index.php', 1, 1);
    const { calls } = makeScriptedSession([[topFrame]]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(calls('stackTrace').length).toBe(1); // baseline only, no polling
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(1);
    expect(result.frame).toEqual(topFrame);
    expect(result.message).toContain('returned immediately without waiting for exit');
  });

  it('cap exceeded: stops after maxIterations stepOut calls with exited:false', async () => {
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    const { calls } = makeScriptedSession([base, base]); // never exits

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(3);
    expect(result.exited).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(2); // always present when frames were observed
    expect(result.frame?.name).toBe('add');
    expect(result.message).toContain('did not leave the function after 3 attempts');
  });

  it('session ends during the wait: reports exited with ended message', async () => {
    const session = mockSession({ id: 'step-session' });
    let stackCalls = 0;
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    session.customRequest = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'stackTrace') {
        stackCalls += 1;
        if (stackCalls === 1) return { stackFrames: base };
        // Realistic close path: the session is gone from the registry before
        // the adapter throws, so the error classifies as 'ended'.
        dapBridge.__clearSessionsForTesting();
        throw new Error('unknown thread');
      }
      if (command === 'stepOut') return {};
      return {};
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBeUndefined();
    expect(result.message).toBe('Debug session ended during step_out.');
  });

  it('transient error while the session is still registered: rethrows instead of classifying as ended', async () => {
    const session = mockSession({ id: 'step-session' });
    let stackCalls = 0;
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    session.customRequest = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'stackTrace') {
        stackCalls += 1;
        if (stackCalls === 1) return { stackFrames: base };
        throw new Error('connection lost'); // session NOT removed from the registry
      }
      if (command === 'stepOut') return {};
      return {};
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    await expect(dapBridge.stepOut({ threadId: 1 })).rejects.toThrow('connection lost');
  });

  it('never stops: throws descriptive timeout error', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      let stackCalls = 0;
      const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          stackCalls += 1;
          if (stackCalls === 1) return { stackFrames: base };
          throw new Error('notStopped');
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, stopTimeoutMs: 1000 });
      const assertion = expect(promise).rejects.toThrow('Timed out waiting for step_out to complete after 1000ms.');
      await vi.advanceTimersByTimeAsync(2500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('recursion: depth drop beats unchanged top-frame name (key regression)', async () => {
    const base = [mkFrame('add', 5, 1), mkFrame('add', 12, 2), mkFrame('{main}', 14, 3)];
    const { calls } = makeScriptedSession([base, [mkFrame('add', 13, 4), mkFrame('{main}', 14, 3)]]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(3);
    expect(result.depthAfter).toBe(2);
    expect(result.frame?.name).toBe('add');
    expect(result.frame?.line).toBe(13);
  });

  it('thread auto-resolution: resolves threadId from threads probe', async () => {
    const session = mockSession({ id: 'step-session' });
    let stackCalls = 0;
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    session.customRequest = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'threads') return { threads: [{ id: 7 }] };
      if (command === 'stackTrace') {
        stackCalls += 1;
        if (stackCalls === 1) return { stackFrames: base };
        return { stackFrames: [mkFrame('{main}', 13, 3)] };
      }
      if (command === 'stepOut') return {};
      return {};
    });
    dapBridge.__addSessionForTesting(session);
    vscode.debug.activeDebugSession = session;

    const result = await dapBridge.stepOut({});

    expect(result.exited).toBe(true);
    const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'stepOut'
    );
    expect(stepCalls.length).toBe(1);
    expect(stepCalls[0][1]).toEqual({ threadId: 7 });
    const stackTraceCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'stackTrace'
    );
    expect(stackTraceCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of stackTraceCalls) {
      expect(call[1].threadId).toBe(7);
    }
  });

  it('depth increase: stops on a breakpoint inside a nested function instead of re-stepping', async () => {
    const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
    const after = [mkFrame('nested', 9, 4), mkFrame('add', 12, 5), mkFrame('{main}', 13, 3)];
    const { calls } = makeScriptedSession([base, after]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(result.exited).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(3);
    expect(result.frame?.name).toBe('nested');
    expect(result.message).toContain('nested function');
    expect(result.message).toContain('nested');
  });

  it('same-depth name change (adapter quirk): treated as exited', async () => {
    const base = [mkFrame('greet', 8, 1), mkFrame('{main}', 17, 2)];
    const after = [mkFrame('helper', 5, 4), mkFrame('{main}', 17, 2)];
    const { calls } = makeScriptedSession([base, after]);

    const result = await dapBridge.stepOut({ threadId: 1 });

    expect(calls('stepOut').length).toBe(1);
    expect(result.exited).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.depthBefore).toBe(2);
    expect(result.depthAfter).toBe(2);
    expect(result.frame?.name).toBe('helper');
  });

  it('H1: adapter never responds after stepOut (queued probe) — raced timer bounds the wait', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      let stackCalls = 0;
      const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          stackCalls += 1;
          if (stackCalls === 1) return { stackFrames: base };
          // The real xdebug.php-debug adapter queues the probe until the next
          // stop and never settles it — the raced timer must fire instead.
          return new Promise(() => {});
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, stopTimeoutMs: 1000 });
      const assertion = expect(promise).rejects.toThrow('Timed out waiting for step_out to complete after 1000ms.');
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'stepOut'
      );
      expect(stepCalls.length).toBe(1); // no stepOut was issued after the timeout
    } finally {
      vi.useRealTimers();
    }
  });

  it('H1: slow probes consume the overall deadline — no stepOut after the budget is gone', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      let stackCalls = 0;
      const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          stackCalls += 1;
          if (stackCalls === 1) return { stackFrames: base };
          // Two slow probes: each resolves after 1200ms with the SAME frames
          // (the return-line intermediate stop), so the loop would re-step.
          return new Promise((resolve) => setTimeout(() => resolve({ stackFrames: base }), 1200));
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, overallTimeoutMs: 2000 });
      const assertion = expect(promise).rejects.toThrow('Timed out waiting for step_out to complete after 800ms.');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'stepOut'
      );
      // Iteration 1 used the full 2000ms budget (probe resolved at 1200ms);
      // iteration 2 was clamped to the remaining 800ms and timed out. Exactly
      // two stepOuts: none after the overall deadline.
      expect(stepCalls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('H1: slow baseline eats the overall budget — raced baseline timer bounds the handler', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      const base = [mkFrame('add', 3, 1), mkFrame('{main}', 12, 2)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          // The baseline depth probe itself resolves only after 1500ms — after
          // the overall deadline (1000ms). The raced baseline timer must fire
          // first and bound the handler.
          return new Promise((resolve) => setTimeout(() => resolve({ stackFrames: base }), 1500));
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, overallTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.exited).toBe(false);
      expect(result.iterations).toBe(0);
      expect(result.depthBefore).toBe(0);
      expect(result.depthAfter).toBe(0);
      expect(result.message).toContain('exceeded its overall deadline of 1000ms');
      expect(result.message).toContain('before the stack could be probed');
      const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'stepOut'
      );
      expect(stepCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: slow baseline at top level (depth 1) — no orphaned stepOut after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      const base = [mkFrame('{main}', 12, 1)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          // RUNNING-at-top-level scenario: the real adapter queues the probe
          // until the next stop; here it resolves only after the deadline.
          return new Promise((resolve) => setTimeout(() => resolve({ stackFrames: base }), 1500));
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, overallTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.exited).toBe(false);
      expect(result.iterations).toBe(0);
      expect(result.depthBefore).toBe(0);
      expect(result.depthAfter).toBe(0);
      const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'stepOut'
      );
      expect(stepCalls.length).toBe(0); // the F1 orphaned-stepOut leak is closed
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: baseline resolving at the deadline at top level — gate blocks the step (reviewer spec)', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession({ id: 'step-session' });
      const base = [mkFrame('{main}', 12, 1)];
      session.customRequest = vi.fn().mockImplementation(async (command: string) => {
        if (command === 'stackTrace') {
          // Probe resolves at exactly the deadline (1000ms); its setTimeout is
          // created before the race's reject timer, so fake timers fire it
          // first and the probe wins the race → the single-shot gate is hit.
          return new Promise((resolve) => setTimeout(() => resolve({ stackFrames: base }), 1000));
        }
        if (command === 'stepOut') return {};
        return {};
      });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      const promise = dapBridge.stepOut({ threadId: 1, overallTimeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.exited).toBe(false);
      expect(result.iterations).toBe(0);
      expect(result.depthBefore).toBe(1);
      expect(result.depthAfter).toBe(1);
      expect(result.message).toContain('exceeded its overall deadline of 1000ms');
      const stepCalls = (session.customRequest as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'stepOut'
      );
      expect(stepCalls.length).toBe(0); // no orphaned stepOut past the deadline
    } finally {
      vi.useRealTimers();
    }
  });
});
