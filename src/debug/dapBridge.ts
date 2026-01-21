import * as vscode from 'vscode';

// Thin DAP bridge for MCP tools; keeps session selection and request shapes centralized.

interface StackFrame {
  id: number;
  name: string;
  line: number;
  column?: number;
  source?: unknown;
}

interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

interface EvaluateResult {
  result: string;
  type?: string;
  variablesReference?: number;
  [key: string]: unknown;
}

interface BreakpointUpdate {
  id?: number;
  verified?: boolean;
  message?: string;
  [key: string]: unknown;
}

interface ThreadInfo {
  id: number;
  name: string;
}

interface DebugSessionInfo {
  id: string;
  name: string;
  type: string;
  workspaceFolder?: string;
}

export interface DebugStatus {
  session: DebugSessionInfo;
  stopped: boolean;
  threadId?: number;
  threads?: ThreadInfo[];
}

// Cache sessions because @types/vscode does not expose a session list in all versions.
const sessionRegistry = new Map<string, vscode.DebugSession>();

function trackSession(session: vscode.DebugSession): void {
  sessionRegistry.set(session.id, session);
}

function describeSession(session: vscode.DebugSession): DebugSessionInfo {
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    workspaceFolder: session.workspaceFolder?.uri.fsPath
  };
}

// Register debug session lifecycle listeners tied to the extension's subscriptions.
export function registerSessionTracking(subscriptions: vscode.Disposable[]): void {
  // Register the current active session so tools can work immediately.
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession) {
    trackSession(activeSession);
  }

  subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      trackSession(session);
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      sessionRegistry.delete(session.id);
    }),
    vscode.debug.onDidChangeActiveDebugSession(session => {
      if (session) {
        trackSession(session);
      }
    })
  );
}

// Resolve a specific session or fall back to the active session for agent workflows.
function getSession(sessionId?: string): vscode.DebugSession {
  if (sessionId) {
    const session = sessionRegistry.get(sessionId);
    if (!session) {
      throw new Error(`Debug session not found: ${sessionId}`);
    }
    return session;
  }

  const session = vscode.debug.activeDebugSession;
  if (!session) {
    throw new Error('No active debug session');
  }
  return session;
}

// DAP signals "notStopped" when requesting stack data during execution.
function isNotStoppedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('notStopped')) {
    return true;
  }

  const errorWithBody = error as { body?: { error?: { id?: string } } };
  return errorWithBody?.body?.error?.id === 'notStopped';
}

async function safeThreads(session: vscode.DebugSession): Promise<ThreadInfo[]> {
  try {
    const response = (await session.customRequest('threads')) as { threads?: ThreadInfo[] };
    return Array.isArray(response?.threads) ? response.threads : [];
  } catch {
    return [];
  }
}

export async function listSessions(): Promise<DebugSessionInfo[]> {
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession && !sessionRegistry.has(activeSession.id)) {
    trackSession(activeSession);
  }
  return Array.from(sessionRegistry.values()).map(describeSession);
}

// Determine whether a session is currently stopped by probing stackTrace.
export async function status(sessionId?: string): Promise<DebugStatus> {
  const session = getSession(sessionId);
  const sessionInfo = describeSession(session);
  const threads = await safeThreads(session);
  const threadId = threads[0]?.id ?? 1;

  let stopped = false;
  try {
    // If stackTrace succeeds, the debug adapter is stopped and ready for inspection.
    await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
    stopped = true;
  } catch (error) {
    if (!isNotStoppedError(error)) {
      throw error;
    }
  }

  return {
    session: sessionInfo,
    stopped,
    threadId,
    threads
  };
}

// Enumerate threads for the selected session.
export async function threads(sessionId?: string): Promise<ThreadInfo[]> {
  const session = getSession(sessionId);
  const response = (await session.customRequest('threads')) as { threads?: ThreadInfo[] };
  return Array.isArray(response?.threads) ? response.threads : [];
}

// Stack trace request with optional pagination.
export async function stack(options: {
  sessionId?: string;
  threadId?: number;
  startFrame?: number;
  levels?: number;
} = {}): Promise<StackFrame[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('stackTrace', {
    threadId: options.threadId ?? 1,
    startFrame: options.startFrame ?? 0,
    levels: options.levels
  })) as { stackFrames?: StackFrame[] };
  return Array.isArray(response?.stackFrames) ? response.stackFrames : [];
}

// Scope list for a single frame.
export async function scopes(frameId: number, sessionId?: string): Promise<Scope[]> {
  const session = getSession(sessionId);
  const response = (await session.customRequest('scopes', { frameId })) as { scopes?: Scope[] };
  return Array.isArray(response?.scopes) ? response.scopes : [];
}

// Variable list request with optional paging and filters.
export async function variables(options: {
  sessionId?: string;
  variablesReference: number;
  start?: number;
  count?: number;
  filter?: 'indexed' | 'named';
}): Promise<Variable[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('variables', {
    variablesReference: options.variablesReference,
    start: options.start,
    count: options.count,
    filter: options.filter
  })) as { variables?: Variable[] };
  return Array.isArray(response?.variables) ? response.variables : [];
}

// Expression evaluation in a specific frame.
export async function evaluate(options: {
  sessionId?: string;
  expression: string;
  frameId?: number;
  context?: 'watch' | 'repl' | 'hover' | 'clipboard';
}): Promise<EvaluateResult> {
  const session = getSession(options.sessionId);
  return (await session.customRequest('evaluate', {
    expression: options.expression,
    frameId: options.frameId,
    context: options.context
  })) as EvaluateResult;
}

export type SourceBreakpoint = {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};

export type FunctionBreakpoint = {
  name: string;
  condition?: string;
  hitCondition?: string;
};

export type ExceptionBreakpointOptions = {
  filters: string[];
  exceptionOptions?: unknown[];
};

// Source breakpoints are keyed by file path.
export async function setFileBreakpoints(options: {
  sessionId?: string;
  file: string;
  breakpoints: SourceBreakpoint[];
  sourceModified?: boolean;
}): Promise<BreakpointUpdate[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('setBreakpoints', {
    source: { path: options.file },
    breakpoints: options.breakpoints,
    sourceModified: options.sourceModified ?? false
  })) as { breakpoints?: BreakpointUpdate[] };
  return Array.isArray(response?.breakpoints) ? response.breakpoints : [];
}

// Function breakpoints are keyed by function name.
export async function setFunctionBreakpoints(options: {
  sessionId?: string;
  breakpoints: FunctionBreakpoint[];
}): Promise<BreakpointUpdate[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('setFunctionBreakpoints', {
    breakpoints: options.breakpoints
  })) as { breakpoints?: BreakpointUpdate[] };
  return Array.isArray(response?.breakpoints) ? response.breakpoints : [];
}

// Exception filters are adapter-specific and depend on Xdebug capabilities.
export async function setExceptionBreakpoints(options: ExceptionBreakpointOptions & { sessionId?: string }): Promise<BreakpointUpdate[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('setExceptionBreakpoints', {
    filters: options.filters,
    exceptionOptions: options.exceptionOptions
  })) as { breakpoints?: BreakpointUpdate[] };
  return Array.isArray(response?.breakpoints) ? response.breakpoints : [];
}

export async function clearFileBreakpoints(options: { sessionId?: string; file: string }): Promise<BreakpointUpdate[]> {
  return setFileBreakpoints({ sessionId: options.sessionId, file: options.file, breakpoints: [] });
}

// Execution control helpers.
export async function cont(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('continue', { threadId: options.threadId ?? 1 });
}

export async function next(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('next', { threadId: options.threadId ?? 1 });
}

export async function stepIn(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('stepIn', { threadId: options.threadId ?? 1 });
}

export async function stepOut(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('stepOut', { threadId: options.threadId ?? 1 });
}

export async function pause(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('pause', { threadId: options.threadId ?? 1 });
}

export async function restart(sessionId?: string): Promise<void> {
  const session = getSession(sessionId);
  await session.customRequest('restart');
}

export async function terminate(options: { sessionId?: string; restart?: boolean } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('terminate', { restart: options.restart });
}

export async function disconnect(options: {
  sessionId?: string;
  terminateDebuggee?: boolean;
  restart?: boolean;
  suspendDebuggee?: boolean;
} = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('disconnect', {
    terminateDebuggee: options.terminateDebuggee,
    restart: options.restart,
    suspendDebuggee: options.suspendDebuggee
  });
}
