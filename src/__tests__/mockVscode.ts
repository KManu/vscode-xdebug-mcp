import { vi } from 'vitest';

/**
 * Reusable VS Code API mocks for testing MCP/Xdebug components.
 * These mocks allow unit testing without loading the real vscode module.
 */

export interface MockDebugSession {
  id: string;
  name: string;
  type: string;
  workspaceFolder?: { uri: { fsPath: string } };
  customRequest: (command: string, args?: unknown) => Promise<unknown>;
}

export interface MockWorkspaceFolder {
  uri: { fsPath: string; toString: () => string };
  name: string;
  index: number;
}

export interface MockUri {
  fsPath: string;
  toString: () => string;
  path: string;
  scheme: string;
  authority: string;
  query: string;
  fragment: string;
  with: (change: Partial<MockUri>) => MockUri;
  parse: (value: string) => MockUri;
  file: (path: string) => MockUri;
  joinPath: (...segments: string[]) => MockUri;
}

export interface MockPosition {
  line: number;
  character: number;
}

export interface MockLocation {
  uri: MockUri;
  range?: { start: MockPosition; end: MockPosition };
}

export interface MockSourceBreakpoint {
  location: MockLocation;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface MockFunctionBreakpoint {
  name: string;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
}

/**
 * Creates a mock DebugSession with the specified overrides.
 */
export function createMockDebugSession(overrides?: Partial<MockDebugSession>): MockDebugSession {
  return {
    id: 'test-session-1',
    name: 'Test PHP Debug',
    type: 'php',
    workspaceFolder: undefined,
    customRequest: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Creates a mock WorkspaceFolder with the specified path.
 */
export function createMockWorkspaceFolder(fsPath: string): MockWorkspaceFolder {
  const uri: MockUri = {
    fsPath,
    toString: () => `file://${fsPath}`,
    path: fsPath,
    scheme: 'file',
    authority: '',
    query: '',
    fragment: '',
    with: vi.fn().mockImplementation((change: Partial<MockUri>) => ({ ...uri, ...change })),
    parse: vi.fn().mockImplementation((value: string) => ({ ...uri, fsPath: value })),
    file: vi.fn().mockImplementation((path: string) => ({ ...uri, fsPath: path })),
    joinPath: vi.fn().mockImplementation((...segments: string[]) => ({
      ...uri,
      fsPath: `${fsPath}/${segments.join('/')}`,
    })),
  };

  return {
    uri,
    name: fsPath.split('/').pop() || fsPath,
    index: 0,
  };
}

/**
 * Creates mock Uri functions for vscode.Uri.
 */
export function createMockUri(): typeof import('vscode').Uri {
  return {
    file: vi.fn().mockImplementation((path: string) => ({
      fsPath: path,
      toString: () => `file://${path}`,
      path,
      scheme: 'file',
      authority: '',
      query: '',
      fragment: '',
      with: vi.fn(),
      parse: vi.fn(),
      joinPath: vi.fn().mockImplementation((...segments: string[]) => ({
        fsPath: `${path}/${segments.join('/')}`,
        toString: () => `file://${path}/${segments.join('/')}`,
        path,
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
    joinPath: vi.fn().mockImplementation((uri: MockUri, ...segments: string[]) => ({
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
  } as unknown as typeof import('vscode').Uri;
}

/**
 * Sets up vi.mock for the vscode debug module.
 * Call this in beforeEach or setup file.
 */
export function mockVscodeDebug(): void {
  vi.mock('vscode', async () => {
    const mockUri = createMockUri();

    return {
      Uri: mockUri,
      debug: {
        activeDebugSession: undefined,
        onDidStartDebugSession: vi.fn(),
        onDidTerminateDebugSession: vi.fn(),
        onDidChangeActiveDebugSession: vi.fn(),
        addBreakpoints: vi.fn(),
        removeBreakpoints: vi.fn(),
      },
      workspace: {
        workspaceFolders: undefined,
        fs: {
          stat: vi.fn().mockResolvedValue({}),
        },
      },
      Position: vi.fn().mockImplementation((line: number, character: number) => ({ line, character })),
      Location: vi.fn().mockImplementation((uri: MockUri, position: MockPosition) => ({ uri, range: { start: position, end: position } })),
      SourceBreakpoint: vi.fn().mockImplementation((location: MockLocation, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) => ({
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
}

/**
 * Sets up vi.mock for the vscode workspace module.
 */
export function mockVscodeWorkspace(): void {
  vi.mock('vscode', async () => {
    const mockUri = createMockUri();

    return {
      Uri: mockUri,
      workspace: {
        workspaceFolders: undefined,
        fs: {
          stat: vi.fn().mockResolvedValue({}),
        },
      },
    };
  });
}

/**
 * Sets up vi.mock for vscode.Uri functions.
 */
export function mockVscodeUri(): void {
  vi.mock('vscode', async () => {
    const mockUri = createMockUri();

    return {
      Uri: mockUri,
    };
  });
}
