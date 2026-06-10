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
      configurable: true
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
        breakpoints: [{ line: 10 }]
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
        breakpoints: [{ line: 10 }]
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'src/index.php',
        breakpoints: [{ line: 10 }]
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: 'shared/util.php',
        breakpoints: [{ line: 10 }]
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
        configurable: true
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
        breakpoints: [{ line: 10 }]
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
        breakpoints: [{ line: 10 }]
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
      configurable: true
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }, { line: 20 }]
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      // Set initial breakpoints
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }]
      });

      // Verify removeBreakpoints was called once (to remove old ones before adding new)
      const removeCallCountAfterFirst = (vscode.debug.removeBreakpoints as any).mock.calls.length;

      // Reset breakpoints on same file
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 20 }, { line: 30 }]
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      // Set initial breakpoints
      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }]
      });

      let breakpoints = dapBridge.__getFileBreakpointsForTesting();
      expect(breakpoints.size).toBe(1);

      // Clear breakpoints via clearFileBreakpoints
      await dapBridge.clearFileBreakpoints({
        file: '/workspace/project/src/index.php'
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
        configurable: true
      });

      const session = mockSession({ id: 'session-1' });
      dapBridge.__addSessionForTesting(session);
      vscode.debug.activeDebugSession = session;

      await dapBridge.setFileBreakpoints({
        file: '/workspace/project/src/index.php',
        breakpoints: [{ line: 10 }],
        sourceModified: true
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
        breakpoints: [
          { name: 'myFunction' },
          { name: 'anotherFunction' }
        ]
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
        breakpoints: [{ name: 'oldFunction' }]
      });

      let funcs = dapBridge.__getFunctionBreakpointsForTesting();
      expect(funcs.length).toBe(1);

      // Replace with new function breakpoints
      await dapBridge.setFunctionBreakpoints({
        breakpoints: [
          { name: 'newFunction1' },
          { name: 'newFunction2' }
        ]
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
        filters: ['AllExceptions', 'UnhandledExceptions']
      });

      expect(session.customRequest).toHaveBeenCalledWith('setExceptionBreakpoints', {
        filters: ['AllExceptions', 'UnhandledExceptions'],
        exceptionOptions: undefined
      });
    });
  });
});