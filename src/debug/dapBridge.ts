import * as vscode from 'vscode';

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

function activeSession(): vscode.DebugSession {
  const session = vscode.debug.activeDebugSession;
  if (!session) {
    throw new Error('No active debug session');
  }
  return session;
}

export async function stack(threadId = 1): Promise<StackFrame[]> {
  const session = activeSession();
  const response = (await session.customRequest('stackTrace', { threadId })) as {
    stackFrames?: StackFrame[];
  };
  return Array.isArray(response?.stackFrames) ? response.stackFrames : [];
}

export async function scopes(frameId: number): Promise<Scope[]> {
  const session = activeSession();
  const response = (await session.customRequest('scopes', { frameId })) as {
    scopes?: Scope[];
  };
  return Array.isArray(response?.scopes) ? response.scopes : [];
}

export async function variables(variablesReference: number): Promise<Variable[]> {
  const session = activeSession();
  const response = (await session.customRequest('variables', { variablesReference })) as {
    variables?: Variable[];
  };
  return Array.isArray(response?.variables) ? response.variables : [];
}

export async function evaluate(expression: string, frameId?: number): Promise<EvaluateResult> {
  const session = activeSession();
  return (await session.customRequest('evaluate', { expression, frameId })) as EvaluateResult;
}

export type SourceBreakpoint = {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};

export async function setFileBreakpoints(file: string, breakpoints: SourceBreakpoint[]): Promise<BreakpointUpdate[]> {
  const session = activeSession();
  const response = (await session.customRequest('setBreakpoints', {
    source: { path: file },
    breakpoints,
    sourceModified: false
  })) as { breakpoints?: BreakpointUpdate[] };
  return Array.isArray(response?.breakpoints) ? response.breakpoints : [];
}

export async function cont(threadId = 1): Promise<void> {
  await activeSession().customRequest('continue', { threadId });
}

export async function next(threadId = 1): Promise<void> {
  await activeSession().customRequest('next', { threadId });
}

export async function stepIn(threadId = 1): Promise<void> {
  await activeSession().customRequest('stepIn', { threadId });
}

export async function stepOut(threadId = 1): Promise<void> {
  await activeSession().customRequest('stepOut', { threadId });
}
