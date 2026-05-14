import { vi } from 'vitest';

/**
 * Shared vitest setup file — runs before any test file.
 * Sets up the vscode mock once so all test files can import from it.
 */

// Mock vscode module globally
vi.mock('vscode', async () => {
  // Inline the mock factory here since vi.hoisted isn't available in setupFiles
  // and we can't import from mockVscode.ts before vi.mock resolves.
  const mockUri = {
    file: vi.fn().mockImplementation((filePath: string) => ({
      fsPath: filePath,
      toString: () => `file://${filePath}`,
      path: filePath,
      scheme: 'file',
      authority: '',
      query: '',
      fragment: '',
      with: vi.fn(),
      parse: vi.fn(),
      joinPath: vi.fn().mockImplementation((...segments: string[]) => ({
        fsPath: `${filePath}/${segments.join('/')}`,
        toString: () => `file://${filePath}/${segments.join('/')}`,
        path: filePath,
        scheme: 'file',
        authority: '',
        query: '',
        fragment: '',
        with: vi.fn(),
        parse: vi.fn(),
        joinPath: vi.fn(),
      })),
    })),
    parse: vi.fn().mockImplementation((value: string) => ({
      fsPath: value,
      toString: () => value,
      path: value,
      scheme: value.startsWith('file://') ? 'file' : 'http',
      authority: '',
      query: '',
      fragment: '',
      with: vi.fn(),
      parse: vi.fn(),
      joinPath: vi.fn(),
    })),
    joinPath: vi.fn().mockImplementation((uri: any, ...segments: string[]) => ({
      fsPath: `${uri.fsPath}/${segments.join('/')}`,
      toString: () => `file://${uri.fsPath}/${segments.join('/')}`,
      path: `${uri.fsPath}/${segments.join('/')}`,
      scheme: 'file',
      authority: '',
      query: '',
      fragment: '',
      with: vi.fn(),
      parse: vi.fn(),
      joinPath: vi.fn(),
    })),
    from: vi.fn(),
    isUri: vi.fn(),
  };

  return {
    Uri: mockUri,
    debug: {
      activeDebugSession: undefined as any,
      onDidStartDebugSession: vi.fn(),
      onDidTerminateDebugSession: vi.fn(),
      onDidChangeActiveDebugSession: vi.fn(),
      addBreakpoints: vi.fn(),
      removeBreakpoints: vi.fn(),
    },
    workspace: {
      workspaceFolders: undefined as any,
      fs: {
        stat: vi.fn().mockResolvedValue({}),
      },
    },
    Position: vi.fn().mockImplementation((line: number, character: number) => ({ line, character })),
    Location: vi.fn().mockImplementation((uri: any, position: any) => ({ uri, range: { start: position, end: position } })),
    SourceBreakpoint: vi.fn().mockImplementation((location: any, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) => ({
      location,
      enabled: enabled ?? true,
      condition,
      hitCondition,
      logMessage,
    })),
    FunctionBreakpoint: vi.fn().mockImplementation((name: string, enabled?: boolean, condition?: string, hitCondition?: string) => ({
      name,
      enabled: enabled ?? true,
      condition,
      hitCondition,
    })),
  };
});
