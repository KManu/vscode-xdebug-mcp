import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { isNotStoppedError } from './errors';

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

export interface StepOutResult {
  exited: boolean;
  iterations: number;
  frame?: StackFrame; // top frame after the final stop (undefined if session ended)
  depthBefore: number;
  depthAfter?: number; // undefined if session ended mid-step
  message?: string; // set when exited === false, when the session ended mid-step,
  // or when the top-level single-shot path returned without waiting
}

// stepOut auto-repeat tuning. Real Xdebug stops first at the function's return
// line on step_out (an intermediate stop); the loop re-steps until the stack
// depth decreases, bounded by STEP_OUT_MAX_ITERATIONS.
const STEP_OUT_MAX_ITERATIONS = 3; // quirk needs 2; 3 gives margin
const STEP_OUT_STOP_TIMEOUT_MS = 10000; // per-iteration wait for the stop
const STEP_OUT_POLL_MS = 150; // poll interval while waiting for the stop
const DEPTH_PROBE_LEVELS = 256; // stackTrace depth for exit detection
// ONE overall deadline for the whole step_out loop. The MCP request arrives
// over HTTP with httpTransport REQUEST_TIMEOUT_MS = 30000; after that the
// transport answers 408 and destroys the socket, so the loop must stop issuing
// step commands well before it. The real xdebug.php-debug adapter queues
// stackTrace until the next stop and never throws notStopped, so this deadline
// — not the per-iteration timeout — is what actually bounds the loop.
const STEP_OUT_OVERALL_TIMEOUT_MS = 25000;

// Cache sessions because @types/vscode does not expose a session list in all versions.
const sessionRegistry = new Map<string, vscode.DebugSession>();
// Track MCP-managed breakpoints so we only remove what we added.
const mcpFileBreakpoints = new Map<string, vscode.SourceBreakpoint[]>();
let mcpFunctionBreakpoints: vscode.FunctionBreakpoint[] = [];

/** Tracks pending breakpoint verifications keyed by vscode.SourceBreakpoint reference. */
const pendingFileVerifications = new WeakMap<
  vscode.SourceBreakpoint,
  { resolve: (result: BreakpointUpdate) => void; reject: (err: Error) => void }
>();

/** Tracks pending function breakpoint verifications. */
const pendingFuncVerifications = new WeakMap<
  vscode.FunctionBreakpoint,
  { resolve: (result: BreakpointUpdate) => void; reject: (err: Error) => void }
>();

function trackSession(session: vscode.DebugSession): void {
  sessionRegistry.set(session.id, session);
}

function describeSession(session: vscode.DebugSession): DebugSessionInfo {
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    workspaceFolder: session.workspaceFolder?.uri.fsPath,
  };
}

function getSessionIfAvailable(sessionId?: string): vscode.DebugSession | undefined {
  if (sessionId) {
    return sessionRegistry.get(sessionId);
  }
  return vscode.debug.activeDebugSession;
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function looksLikeUri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error: any) {
    // Only treat "file not found" as false; re-throw permission/IO errors.
    if (error?.code === 'FileNotFound' || error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function resolveFileUri(file: string, sessionId?: string): Promise<vscode.Uri> {
  const trimmed = file.trim();
  if (!trimmed) {
    throw new Error('file path must be provided');
  }

  if (looksLikeUri(trimmed)) {
    return vscode.Uri.parse(trimmed);
  }

  if (isWindowsDrivePath(trimmed) || path.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }

  const candidateFolders: vscode.WorkspaceFolder[] = [];
  const session = getSessionIfAvailable(sessionId);
  if (session?.workspaceFolder) {
    candidateFolders.push(session.workspaceFolder);
  }
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    if (!candidateFolders.some((candidate) => candidate.uri.toString() === folder.uri.toString())) {
      candidateFolders.push(folder);
    }
  }

  if (candidateFolders.length === 0) {
    // Fall back to resolving against the extension host cwd if no workspace is open.
    return vscode.Uri.file(path.resolve(trimmed));
  }

  for (const folder of candidateFolders) {
    const candidate = vscode.Uri.joinPath(folder.uri, trimmed);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return vscode.Uri.joinPath(candidateFolders[0].uri, trimmed);
}

// Register debug session lifecycle listeners tied to the extension's subscriptions.
export function registerSessionTracking(subscriptions: vscode.Disposable[]): void {
  // Register the current active session so tools can work immediately.
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession) {
    trackSession(activeSession);
  }

  subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      trackSession(session);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      sessionRegistry.delete(session.id);
    }),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (session) {
        trackSession(session);
      }
    })
  );

  // Track real breakpoint verification status via onDidChangeBreakpoints.
  subscriptions.push(
    vscode.debug.onDidChangeBreakpoints(async (event) => {
      const session = vscode.debug.activeDebugSession;
      if (!session) {
        return;
      }

      for (const bp of event.added) {
        if (bp instanceof vscode.SourceBreakpoint && pendingFileVerifications.has(bp)) {
          const { resolve } = pendingFileVerifications.get(bp)!;
          pendingFileVerifications.delete(bp);
          try {
            const dapBp = await session.getDebugProtocolBreakpoint(bp);
            const verified = (dapBp as Record<string, unknown>)?.verified;
            resolve({
              verified: verified !== false,
              message: (dapBp as Record<string, unknown>)?.message as string | undefined,
            });
          } catch (err) {
            log.error(
              `[dapBridge] getDebugProtocolBreakpoint failed: ${err instanceof Error ? err.message : String(err)}`
            );
            resolve({ verified: true, message: 'Verification unavailable (inline adapter fallback)' });
          }
        }

        if (bp instanceof vscode.FunctionBreakpoint && pendingFuncVerifications.has(bp)) {
          const { resolve } = pendingFuncVerifications.get(bp)!;
          pendingFuncVerifications.delete(bp);
          try {
            const dapBp = await session.getDebugProtocolBreakpoint(bp);
            const verified = (dapBp as Record<string, unknown>)?.verified;
            resolve({
              verified: verified !== false,
              message: (dapBp as Record<string, unknown>)?.message as string | undefined,
            });
          } catch (err) {
            log.error(
              `[dapBridge] getDebugProtocolBreakpoint failed: ${err instanceof Error ? err.message : String(err)}`
            );
            resolve({ verified: true, message: 'Verification unavailable (inline adapter fallback)' });
          }
        }
      }

      // Handle changed breakpoints (async verification transitions, e.g. unverified→verified)
      for (const bp of event.changed) {
        if (bp instanceof vscode.SourceBreakpoint && pendingFileVerifications.has(bp)) {
          const { resolve } = pendingFileVerifications.get(bp)!;
          pendingFileVerifications.delete(bp);
          try {
            const dapBp = await session.getDebugProtocolBreakpoint(bp);
            const verified = (dapBp as Record<string, unknown>)?.verified;
            resolve({
              verified: verified !== false,
              message: (dapBp as Record<string, unknown>)?.message as string | undefined,
            });
          } catch (err) {
            log.error(
              `[dapBridge] getDebugProtocolBreakpoint failed: ${err instanceof Error ? err.message : String(err)}`
            );
            resolve({ verified: true, message: 'Verification unavailable (inline adapter fallback)' });
          }
        }
        if (bp instanceof vscode.FunctionBreakpoint && pendingFuncVerifications.has(bp)) {
          const { resolve } = pendingFuncVerifications.get(bp)!;
          pendingFuncVerifications.delete(bp);
          try {
            const dapBp = await session.getDebugProtocolBreakpoint(bp);
            const verified = (dapBp as Record<string, unknown>)?.verified;
            resolve({
              verified: verified !== false,
              message: (dapBp as Record<string, unknown>)?.message as string | undefined,
            });
          } catch (err) {
            log.error(
              `[dapBridge] getDebugProtocolBreakpoint failed: ${err instanceof Error ? err.message : String(err)}`
            );
            resolve({ verified: true, message: 'Verification unavailable (inline adapter fallback)' });
          }
        }
      }

      for (const bp of event.removed) {
        if (bp instanceof vscode.SourceBreakpoint) {
          const entry = pendingFileVerifications.get(bp);
          if (entry) {
            entry.resolve({ verified: false, message: 'Breakpoint removed before verification' });
          }
          pendingFileVerifications.delete(bp);
        }
        if (bp instanceof vscode.FunctionBreakpoint) {
          const entry = pendingFuncVerifications.get(bp);
          if (entry) {
            entry.resolve({ verified: false, message: 'Breakpoint removed before verification' });
          }
          pendingFuncVerifications.delete(bp);
        }
      }
    })
  );
}

// Test helpers - allow tests to populate the session registry directly
export function __addSessionForTesting(session: vscode.DebugSession): void {
  trackSession(session);
}

export function __clearSessionsForTesting(): void {
  sessionRegistry.clear();
}

// Test helpers - allow tests to inspect MCP-managed breakpoint state
export function __getFileBreakpointsForTesting(): Map<string, vscode.SourceBreakpoint[]> {
  return mcpFileBreakpoints;
}

export function __getFunctionBreakpointsForTesting(): vscode.FunctionBreakpoint[] {
  return mcpFunctionBreakpoints;
}

export function getSessionCount(): number {
  return sessionRegistry.size;
}

export function __clearBreakpointsForTesting(): void {
  mcpFileBreakpoints.clear();
  mcpFunctionBreakpoints = [];
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

async function safeThreads(session: vscode.DebugSession): Promise<ThreadInfo[]> {
  try {
    const response = (await session.customRequest('threads')) as { threads?: ThreadInfo[] };
    return Array.isArray(response?.threads) ? response.threads : [];
  } catch (error) {
    log.error(`Failed to get threads: ${error instanceof Error ? error.message : String(error)}`);
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
    threads,
  };
}

// Enumerate threads for the selected session.
export async function threads(sessionId?: string): Promise<ThreadInfo[]> {
  const session = getSession(sessionId);
  const response = (await session.customRequest('threads')) as { threads?: ThreadInfo[] };
  return Array.isArray(response?.threads) ? response.threads : [];
}

// Stack trace for a specific, already-resolved session (internal helper so
// stepOut can reuse the session it already resolved without a second getSession).
async function stackForSession(
  session: vscode.DebugSession,
  options: { threadId?: number; startFrame?: number; levels?: number } = {}
): Promise<StackFrame[]> {
  try {
    // Resolve threadId: DAP thread ids start at 1, so fall back to 1 when the
    // adapter cannot be asked (matches resolveThreadId's fallback).
    let threadId = options.threadId ?? 1;
    if (!options.threadId) {
      try {
        const threadsResp = (await session.customRequest('threads')) as
          | { threads?: { id: number }[] }
          | { body?: { threads?: { id: number }[] } };
        const threads = (threadsResp as any).threads ?? (threadsResp as any).body?.threads ?? [];
        if (threads.length > 0) {
          threadId = threads[0].id;
        }
      } catch {
        threadId = 1;
      }
    }
    const raw = await session.customRequest('stackTrace', {
      threadId,
      startFrame: options.startFrame ?? 0,
      levels: options.levels ?? 20,
    });
    // Real DAP adapters may wrap response in a body property.
    const response = raw as { stackFrames?: StackFrame[]; body?: { stackFrames?: StackFrame[] } };
    const frames = response.stackFrames ?? response.body?.stackFrames;
    if (!Array.isArray(frames)) {
      log.error(`[dapBridge] Unexpected stackTrace response shape: ${JSON.stringify(raw)}`);
    }
    return Array.isArray(frames) ? frames : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error(
        'Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.'
      );
    }
    throw error;
  }
}

// Stack trace request with optional pagination.
export async function stack(
  options: { sessionId?: string; threadId?: number; startFrame?: number; levels?: number } = {}
): Promise<StackFrame[]> {
  const session = getSession(options.sessionId);
  return stackForSession(session, {
    threadId: options.threadId,
    startFrame: options.startFrame,
    levels: options.levels,
  });
}

// Scope list for a single frame.
export async function scopes(frameId: number, sessionId?: string): Promise<Scope[]> {
  const session = getSession(sessionId);
  try {
    const response = (await session.customRequest('scopes', { frameId })) as { scopes?: Scope[] };
    return Array.isArray(response?.scopes) ? response.scopes : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error(
        'Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.'
      );
    }
    throw error;
  }
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
  try {
    const response = (await session.customRequest('variables', {
      variablesReference: options.variablesReference,
      start: options.start,
      count: options.count,
      filter: options.filter,
    })) as { variables?: Variable[] };
    return Array.isArray(response?.variables) ? response.variables : [];
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error(
        'Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.'
      );
    }
    throw error;
  }
}

// Expression evaluation in a specific frame.
export async function evaluate(options: {
  sessionId?: string;
  expression: string;
  frameId?: number;
  context?: 'watch' | 'repl' | 'hover' | 'clipboard';
}): Promise<EvaluateResult> {
  const session = getSession(options.sessionId);
  try {
    return (await session.customRequest('evaluate', {
      expression: options.expression,
      frameId: options.frameId,
      context: options.context,
    })) as EvaluateResult;
  } catch (error) {
    if (isNotStoppedError(error)) {
      throw new Error(
        'Debug session is not stopped. Call wait_for_stop to block until a breakpoint is hit, or pause to interrupt execution.'
      );
    }
    throw error;
  }
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
  const uri = await resolveFileUri(options.file, options.sessionId);
  const key = uri.toString();

  const existing = mcpFileBreakpoints.get(key);
  if (existing && existing.length > 0) {
    vscode.debug.removeBreakpoints(existing);
  }

  const sourceBreakpoints = options.breakpoints.map((breakpoint) => {
    const line = Math.max(1, Math.trunc(breakpoint.line));
    const position = new vscode.Position(line - 1, 0);
    const location = new vscode.Location(uri, position);
    return new vscode.SourceBreakpoint(
      location,
      true,
      breakpoint.condition,
      breakpoint.hitCondition,
      breakpoint.logMessage
    );
  });

  const verificationTimeoutMs = 5000;
  const verificationPromises = sourceBreakpoints.map(
    (bp) =>
      new Promise<BreakpointUpdate>((resolve) => {
        pendingFileVerifications.set(bp, {
          resolve,
          reject: () => resolve({ verified: false, message: 'Verification rejected' }),
        });
        setTimeout(() => {
          if (pendingFileVerifications.has(bp)) {
            pendingFileVerifications.delete(bp);
            resolve({ verified: false, message: 'Verification timeout' });
          }
        }, verificationTimeoutMs);
      })
  );

  if (sourceBreakpoints.length > 0) {
    vscode.debug.addBreakpoints(sourceBreakpoints);
    mcpFileBreakpoints.set(key, sourceBreakpoints);
  } else {
    mcpFileBreakpoints.delete(key);
  }

  return Promise.all(verificationPromises);
}

// Function breakpoints are keyed by function name.
export async function setFunctionBreakpoints(options: {
  sessionId?: string;
  breakpoints: FunctionBreakpoint[];
}): Promise<BreakpointUpdate[]> {
  if (mcpFunctionBreakpoints.length > 0) {
    vscode.debug.removeBreakpoints(mcpFunctionBreakpoints);
  }

  const functionBreakpoints = options.breakpoints.map((breakpoint) => {
    return new vscode.FunctionBreakpoint(breakpoint.name, true, breakpoint.condition, breakpoint.hitCondition);
  });

  mcpFunctionBreakpoints = functionBreakpoints;

  const verificationTimeoutMs = 5000;
  const verificationPromises = functionBreakpoints.map(
    (bp) =>
      new Promise<BreakpointUpdate>((resolve) => {
        pendingFuncVerifications.set(bp, {
          resolve,
          reject: () => resolve({ verified: false, message: 'Verification rejected' }),
        });
        setTimeout(() => {
          if (pendingFuncVerifications.has(bp)) {
            pendingFuncVerifications.delete(bp);
            resolve({ verified: false, message: 'Verification timeout' });
          }
        }, verificationTimeoutMs);
      })
  );

  if (functionBreakpoints.length > 0) {
    vscode.debug.addBreakpoints(functionBreakpoints);
  }

  return Promise.all(verificationPromises);
}

// Exception filters are adapter-specific and depend on Xdebug capabilities.
export async function setExceptionBreakpoints(
  options: ExceptionBreakpointOptions & { sessionId?: string }
): Promise<BreakpointUpdate[]> {
  const session = getSession(options.sessionId);
  const response = (await session.customRequest('setExceptionBreakpoints', {
    filters: options.filters,
    exceptionOptions: options.exceptionOptions,
  })) as { breakpoints?: BreakpointUpdate[] };
  return Array.isArray(response?.breakpoints) ? response.breakpoints : [];
}

export async function clearFileBreakpoints(options: { sessionId?: string; file: string }): Promise<BreakpointUpdate[]> {
  return setFileBreakpoints({ sessionId: options.sessionId, file: options.file, breakpoints: [] });
}

// Resolve the threadId for execution control commands: an explicit id wins,
// then the first thread reported by the adapter, falling back to 1.
async function resolveThreadId(session: vscode.DebugSession, requested?: number): Promise<number> {
  if (requested) {
    return requested;
  }
  try {
    const response = (await session.customRequest('threads')) as {
      threads?: { id: number }[];
      body?: { threads?: { id: number }[] };
    };
    const threads = response.threads ?? response.body?.threads ?? [];
    if (threads.length > 0) {
      return threads[0].id;
    }
  } catch {
    // Adapter may not support the threads request; fall through to the default.
  }
  return 1;
}

/** Rejection marker for the raced per-probe timer. Distinct from DAP notStopped errors. */
class StepWaitTimeoutError extends Error {
  constructor(ms: number) {
    super(`step_out wait probe exceeded ${ms}ms`);
    this.name = 'StepWaitTimeoutError';
  }
}

/**
 * Races a stackTrace probe against a timer. The real xdebug.php-debug adapter
 * queues the probe until the next stop and NEVER throws notStopped, so the
 * timer is the only thing that bounds the wait against it. If the timer wins,
 * the late-resolving DAP response is simply dropped (Promise.race has already
 * settled) — no further step commands may be issued afterwards.
 */
async function raceStackTraceProbe(
  session: vscode.DebugSession,
  threadId: number,
  remainingMs: number
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: DEPTH_PROBE_LEVELS,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepWaitTimeoutError(remainingMs)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Polls stackTrace until the session stops after a step command.
 * Mirrors the wait_for_stop poll loop (server.ts) but calls stackTrace
 * directly so it can observe depth and classify errors:
 *   frames present              -> return frames
 *   raced timer / deadline hit  -> throw
 *                                  'Timed out waiting for step_out to complete after Nms.'
 *   isNotStoppedError(error)    -> keep polling until the deadline, then throw as above
 *   any OTHER error, and the session left the registry -> 'ended'
 *   any OTHER error while the session is still registered -> rethrow (must surface)
 */
async function waitForStepStop(
  session: vscode.DebugSession,
  threadId: number,
  timeoutMs: number,
  pollMs: number
): Promise<StackFrame[] | 'ended'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for step_out to complete after ${timeoutMs}ms.`);
    }
    try {
      const raw = await raceStackTraceProbe(session, threadId, remainingMs);
      const response = raw as { stackFrames?: StackFrame[]; body?: { stackFrames?: StackFrame[] } };
      const frames = response.stackFrames ?? response.body?.stackFrames;
      return Array.isArray(frames) ? frames : [];
    } catch (error) {
      if (error instanceof StepWaitTimeoutError) {
        throw new Error(`Timed out waiting for step_out to complete after ${timeoutMs}ms.`);
      }
      if (isNotStoppedError(error)) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      // Only classify as 'ended' when the session actually left the registry
      // (terminated/disconnected). A transient protocol error while the session
      // is still alive must surface instead of masquerading as a clean end.
      if (!sessionRegistry.has(session.id)) {
        log.warn(
          `[dapBridge] Session likely ended while waiting for step_out: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return 'ended';
      }
      throw error;
    }
  }
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

export async function stepOut(
  options: {
    sessionId?: string;
    threadId?: number;
    maxIterations?: number;
    stopTimeoutMs?: number;
    overallTimeoutMs?: number; // testability knob, NOT exposed in the MCP schema
  } = {}
): Promise<StepOutResult> {
  const session = getSession(options.sessionId);
  const threadId = await resolveThreadId(session, options.threadId);
  const maxIterations = options.maxIterations ?? STEP_OUT_MAX_ITERATIONS; // testability knobs,
  const stopTimeoutMs = options.stopTimeoutMs ?? STEP_OUT_STOP_TIMEOUT_MS; // NOT exposed in the MCP schema
  // ONE overall deadline for the whole operation, derived from the HTTP budget:
  // httpTransport REQUEST_TIMEOUT_MS is 30000, so with STEP_OUT_OVERALL_TIMEOUT_MS
  // = 25000 the loop always finishes (or gives up) before the transport 408s.
  const overallTimeoutMs = options.overallTimeoutMs ?? STEP_OUT_OVERALL_TIMEOUT_MS;
  const overallDeadline = Date.now() + overallTimeoutMs;

  // Pass the already-resolved session down; no second getSession lookup.
  // The baseline probe is raced against the overall deadline: the real
  // xdebug.php-debug adapter queues stackTrace until the next stop (and never
  // throws notStopped), so the timer is the only bound on the handler's
  // lifetime when the debuggee is RUNNING (round-2 F1).
  let before: StackFrame[];
  let baselineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    before = await Promise.race([
      stackForSession(session, { threadId, startFrame: 0, levels: DEPTH_PROBE_LEVELS }),
      new Promise<never>((_, reject) => {
        baselineTimer = setTimeout(
          () => reject(new Error(`step_out baseline probe exceeded ${overallTimeoutMs}ms`)),
          overallTimeoutMs
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('step_out baseline probe exceeded')) {
      return {
        exited: false,
        iterations: 0,
        frame: undefined,
        depthBefore: 0,
        depthAfter: 0,
        message:
          `step_out exceeded its overall deadline of ${overallTimeoutMs}ms before the stack ` +
          'could be probed; no further step commands were issued.',
      };
    }
    throw error;
  } finally {
    if (baselineTimer) {
      clearTimeout(baselineTimer);
    }
  }
  const depthBefore = before.length;
  const topName = before[0]?.name;

  // Top-level frame (depth <= 1): there is no caller to land on, so a full
  // depth loop would never see a depth decrease. DBGp step_out at top level
  // behaves like `run`, so we issue ONE step and return immediately WITHOUT
  // waiting for the exit — the session may still stop at a later breakpoint.
  if (depthBefore <= 1) {
    // Round-2 F1: gate before stepping. Timer drift can let the baseline
    // resolve slightly past the overall deadline (the race timer fired late),
    // and the HTTP client may already have been 408'd — never issue an
    // orphaned stepOut once the budget is gone.
    if (Date.now() >= overallDeadline) {
      return {
        exited: false,
        iterations: 0,
        frame: before[0],
        depthBefore,
        depthAfter: depthBefore,
        message:
          `step_out exceeded its overall deadline of ${overallTimeoutMs}ms before the function ` +
          'was exited; no further step commands were issued.',
      };
    }
    await session.customRequest('stepOut', { threadId });
    return {
      exited: true,
      iterations: 1,
      frame: before[0],
      depthBefore,
      message:
        'step_out returned immediately without waiting for exit (session was at top level); ' +
        'the session may still stop at a later breakpoint.',
    };
  }

  let lastFrames: StackFrame[] | 'ended' = before;
  for (let i = 1; i <= maxIterations; i++) {
    // Overall-deadline gate: never issue another stepOut once the HTTP budget
    // is exhausted; late-resolving DAP responses are dropped by the raced probes.
    if (Date.now() >= overallDeadline) {
      return {
        exited: false,
        iterations: i - 1,
        frame: Array.isArray(lastFrames) ? lastFrames[0] : undefined,
        depthBefore,
        depthAfter: Array.isArray(lastFrames) ? lastFrames.length : undefined,
        message:
          `step_out exceeded its overall deadline of ${overallTimeoutMs}ms before the function ` +
          'was exited; no further step commands were issued.',
      };
    }
    // Clamp the per-iteration wait so its raced timer fires before the HTTP 408.
    const iterationTimeoutMs = Math.min(stopTimeoutMs, overallDeadline - Date.now());
    // Adapter responds to stepOut immediately (phpDebug.js:1156); the stopped
    // event arrives later, so polling afterwards is correct.
    await session.customRequest('stepOut', { threadId });
    lastFrames = await waitForStepStop(session, threadId, iterationTimeoutMs, STEP_OUT_POLL_MS);

    if (lastFrames === 'ended') {
      return { exited: true, iterations: i, depthBefore, message: 'Debug session ended during step_out.' };
    }
    const depthAfter = lastFrames.length;
    const frameAfter = lastFrames[0];
    // Depth INCREASE: the step landed in a nested callee (a breakpoint inside a
    // function called mid-step). Re-stepping would exit the NESTED function,
    // not the original one — stop and report instead.
    if (depthAfter > depthBefore) {
      return {
        exited: false,
        iterations: i,
        frame: frameAfter,
        depthBefore,
        depthAfter,
        message: `stopped at a breakpoint inside a nested function${
          frameAfter?.name ? ` (${frameAfter.name})` : ''
        }; the original function was not exited.`,
      };
    }
    const exited =
      depthAfter < depthBefore || // primary: frame exited
      (depthAfter === depthBefore && !!frameAfter && frameAfter.name !== topName); // secondary: adapter quirk
    if (exited) {
      return { exited: true, iterations: i, frame: frameAfter, depthBefore, depthAfter };
    }
    // Xdebug intermediate stop: still at the function's return line (same depth). Loop.
  }

  return {
    exited: false,
    iterations: maxIterations,
    frame: Array.isArray(lastFrames) ? lastFrames[0] : undefined,
    depthBefore,
    depthAfter: Array.isArray(lastFrames) ? lastFrames.length : undefined,
    message:
      `step_out did not leave the function after ${maxIterations} attempts; ` +
      'the debugger may be stopped at a breakpoint inside the function.',
  };
}

export async function pause(options: { sessionId?: string; threadId?: number } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('pause', { threadId: options.threadId ?? 1 });
}

export async function restart(options: { sessionId?: string } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('restart');
}

/** Waits up to `timeoutMs` for `sessionId` to leave the registry. Returns true if removed. */
async function waitForSessionRemoved(sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sessionRegistry.has(sessionId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !sessionRegistry.has(sessionId);
}

export async function terminate(options: { sessionId?: string; restart?: boolean } = {}): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('terminate', { restart: options.restart });

  // Some debug adapters (notably xdebug.php-debug) acknowledge `terminate`
  // without firing the DAP `terminated` event promptly, so the session
  // lingers in the registry and `list_sessions` keeps reporting it. Fall
  // back to `disconnect({ terminateDebuggee: true })`, which those adapters
  // do honor, then wait briefly for the session to actually disappear.
  if (await waitForSessionRemoved(session.id, 3000)) {
    return;
  }
  try {
    await session.customRequest('disconnect', { terminateDebuggee: true });
  } catch {
    // Adapter may have already torn down the connection; ignore.
  }
  await waitForSessionRemoved(session.id, 2000);
}

export async function disconnect(
  options: { sessionId?: string; terminateDebuggee?: boolean; restart?: boolean; suspendDebuggee?: boolean } = {}
): Promise<void> {
  const session = getSession(options.sessionId);
  await session.customRequest('disconnect', {
    terminateDebuggee: options.terminateDebuggee,
    restart: options.restart,
    suspendDebuggee: options.suspendDebuggee,
  });
}

/**
 * Test helper — resolves a file path to a workspace Uri.
 * STATELESS: does not read sessionRegistry. Integration tests import
 * a separate module instance with an empty registry; this function
 * uses only vscode.workspace.workspaceFolders.
 */
export async function __resolveFileUriForTesting(file: string, sessionId?: string): Promise<vscode.Uri> {
  return resolveFileUri(file, sessionId);
}
