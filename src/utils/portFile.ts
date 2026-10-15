import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { log } from './logger';

// Tests override this to a per-process temp dir so parallel test files
// don't race on the real port file (EPERM on Windows atomic rename).
const PORT_DIR = process.env.XDEBUG_MCP_PORT_DIR || path.join(os.homedir(), '.vscode-xdebug-mcp');
const PORT_FILE = path.join(PORT_DIR, 'port.json');
// Per-process temp name: every VS Code window shares PORT_DIR, so a shared
// temp name lets one window's write/cleanup clobber another's atomic write.
// Exported so the unit tests pin the per-PID naming (H4).
export const TMP_FILE = path.join(PORT_DIR, `port.json.${process.pid}.tmp`);

/** Absolute path of a per-instance discovery entry (`port.<pid>.json`). */
function perPidPath(pid: number): string {
  return path.join(PORT_DIR, `port.${pid}.json`);
}

const PER_PID_PORT_FILE_RE = /^port\.(\d+)\.json$/;

/**
 * Per-instance discovery entry (`port.<pid>.json`).
 *
 * PORT_FILE remains the shared, last-writer-wins pointer for backward
 * compatibility, but it can only describe ONE window: a second VS Code window
 * starting on a fallback port overwrites it and makes the first window
 * undiscoverable. Each window therefore also publishes its own entry, and
 * listActivePortInfos() scans the directory so every live window stays
 * discoverable. Exported so tests/integration can assert the contract.
 */
export const PER_PID_PORT_FILE = perPidPath(process.pid);

export interface PortInfo {
  uri: string;
  host: string;
  port: number;
  version: string;
  pid: number;
  started: string;
}

export interface StoppedInfo {
  status: 'stopped';
  stopped: string;
}

export type PortFileContent = PortInfo | StoppedInfo;

/**
 * Atomic write (write-then-rename) of one discovery file.
 * Failure is non-fatal for the other discovery files.
 */
function atomicWrite(filePath: string, json: string): void {
  fs.mkdirSync(PORT_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, json, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(TMP_FILE, filePath);
}

/**
 * Atomically write port information to the well-known file, plus this
 * window's own per-instance entry (see PER_PID_PORT_FILE).
 *
 * The per-instance entry is written first: it has to survive another window
 * overwriting the shared pointer immediately afterwards.
 */
export function writePortFile(info: PortInfo): void {
  const json = JSON.stringify(info, null, 2);
  try {
    atomicWrite(PER_PID_PORT_FILE, json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to write per-instance port file: ${message}`);
    try {
      fs.unlinkSync(TMP_FILE);
    } catch {
      /* ignore */
    }
  }
  try {
    atomicWrite(PORT_FILE, json);
    log.info(`Port file written to ${PORT_FILE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Failed to write port file: ${message}`);
    // Best-effort cleanup of tmp file.
    try {
      fs.unlinkSync(TMP_FILE);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Atomically mark a discovery file as stopped. Returns false when the marker
 * could not be written; callers must still try to unlink, because readers only
 * ignore a stopped marker (a live-looking entry with an alive PID would keep
 * being returned by listActivePortInfos()).
 */
function writeStoppedFileAt(filePath: string): boolean {
  try {
    const info: StoppedInfo = { status: 'stopped', stopped: new Date().toISOString() };
    atomicWrite(filePath, JSON.stringify(info, null, 2));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to write stopped marker to ${path.basename(filePath)}: ${message}`);
    return false;
  }
}

/**
 * Mark the shared port file as stopped (server is no longer running).
 */
export function writeStoppedFile(): boolean {
  return writeStoppedFileAt(PORT_FILE);
}

function parsePortFileContent(raw: string): PortFileContent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Validate shape before trusting the file.
    if (parsed && typeof parsed === 'object' && parsed.status === 'stopped') {
      return { status: 'stopped', stopped: String(parsed.stopped ?? '') } as StoppedInfo;
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.uri === 'string' && typeof parsed.port === 'number') {
      return {
        uri: parsed.uri as string,
        host: String(parsed.host ?? '127.0.0.1'),
        port: parsed.port as number,
        version: String(parsed.version ?? '0.0.1'),
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        started: String(parsed.started ?? ''),
      } as PortInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the current (shared pointer) port file contents, or null if unavailable.
 */
export function readPortFile(): PortFileContent | null {
  try {
    return parsePortFileContent(fs.readFileSync(PORT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function readPortFileAt(filePath: string): PortFileContent | null {
  try {
    return parsePortFileContent(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every live discovery entry, newest first.
 *
 * Scans the shared pointer (`port.json`) plus all per-instance entries
 * (`port.<pid>.json`), keeps only entries whose owner PID is alive, and
 * de-duplicates by PID (the pointer usually mirrors one of the per-instance
 * files). Never throws: a missing directory or unreadable file simply yields
 * fewer entries. A PID that is missing/invalid is normalized to 0 by the
 * parser and is never treated as a live owner.
 */
export function listActivePortInfos(): PortInfo[] {
  const byPid = new Map<number, PortInfo>();
  const consider = (content: PortFileContent | null): void => {
    if (content === null || 'status' in content) {
      return;
    }
    if (!isOwnerAlive(content.pid)) {
      return;
    }
    // De-duplicate by PID, keeping the newest copy: the pointer and the
    // per-instance file are written from the same string, but a divergent
    // leftover must not shadow the newer entry.
    const existing = byPid.get(content.pid);
    if (existing === undefined || content.started > existing.started) {
      byPid.set(content.pid, content);
    }
  };

  consider(readPortFile());
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(PORT_DIR);
  } catch {
    // Directory does not exist yet (first activation on this machine).
  }
  for (const name of entries) {
    if (PER_PID_PORT_FILE_RE.test(name)) {
      consider(readPortFileAt(path.join(PORT_DIR, name)));
    }
  }

  // Newest first; a missing `started` sorts last, and equal timestamps fall
  // back to the higher PID so the order is deterministic.
  return [...byPid.values()].sort((a, b) => {
    if (a.started !== b.started) {
      return a.started < b.started ? 1 : -1;
    }
    return b.pid - a.pid;
  });
}

/**
 * Returns the active MCP URI — the newest live discovery entry — or null if
 * no window is running.
 */
export function getActiveUri(): string | null {
  return listActivePortInfos()[0]?.uri ?? null;
}

/**
 * Get active port information (newest live discovery entry), or null if none
 * is running.
 */
export function getActivePortInfo(): PortInfo | null {
  return listActivePortInfos()[0] ?? null;
}

/**
 * Check if a process with the given PID is currently running.
 * Uses process.kill(pid, 0) which only checks existence, doesn't signal.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a discovery entry's PID could be a live owner.
 * PID <= 0 (missing/invalid in the file) is never a live owner: process.kill(0)
 * targets the caller's process group, not a real peer process.
 */
function isOwnerAlive(pid: number): boolean {
  return pid > 0 && isPidAlive(pid);
}

export interface StaleSweepResult {
  /** Base names of stale artifacts that were removed. */
  removed: string[];
  /** Base names of artifacts that were examined and left in place. */
  kept: string[];
}

const PER_PID_TMP_RE = /^port\.json\.(\d+)\.tmp$/;

/**
 * Remove discovery artifacts left behind by a process that died without
 * running deactivate() (hard kill, extension-host crash, power loss).
 *
 * Readers ignore dead-PID entries (listActivePortInfos), but nothing else
 * ever removes those files: only their owner unlinks on a clean stop. This is
 * best-effort housekeeping on activate, never a substitute for
 * releaseOwnedPortFile().
 *
 * Safety rules — never throws, never touches a live instance's files:
 *  - a live entry is stale only when its PID is provably not alive;
 *  - a stopped marker is stale by definition (a live owner only writes one
 *    immediately before unlinking it);
 *  - PORT_FILE is re-read and compared (uri + pid + started) right before the
 *    unlink, so a window that replaced the entry mid-sweep keeps it;
 *  - unreadable/corrupt files and temp names without a PID are left alone
 *    (fail closed: deleting what we do not understand could race a writer);
 *  - per-instance entries (`port.<pid>.json`) are removed only when that PID
 *    is provably not alive.
 *
 * Known limits: the confirm-read → unlink sequence is not atomic, so a live
 * window that publishes its entry inside that microsecond window can lose its
 * discovery file (its server keeps running; only discovery is affected). PID
 * liveness is namespace-relative, like the read-time checks: a live peer in a
 * different PID namespace can look dead and be swept.
 */
export function sweepStalePortFiles(): StaleSweepResult {
  const removed: string[] = [];
  const kept: string[] = [];
  const remove = (name: string, fullPath: string) => {
    try {
      fs.unlinkSync(fullPath);
      removed.push(name);
    } catch {
      kept.push(name);
    }
  };

  const current = readPortFile();
  if (current !== null) {
    if ('status' in current) {
      // Re-read before unlinking, same reason as the dead-PID path below:
      // another window may have replaced the marker with a live entry since
      // our first read.
      const confirm = readPortFile();
      if (confirm !== null && 'status' in confirm) {
        remove('port.json', PORT_FILE);
      } else {
        kept.push('port.json');
      }
    } else if (!isOwnerAlive(current.pid)) {
      // Re-read right before unlinking: if another window replaced the dead
      // entry after our first read, the newer (live) content wins.
      const confirm = readPortFile();
      const unchanged =
        confirm !== null &&
        !('status' in confirm) &&
        confirm.uri === current.uri &&
        confirm.pid === current.pid &&
        confirm.started === current.started;
      if (unchanged) {
        remove('port.json', PORT_FILE);
      } else {
        kept.push('port.json');
      }
    } else {
      kept.push('port.json');
    }
  } else {
    try {
      if (fs.existsSync(PORT_FILE)) {
        kept.push('port.json');
      }
    } catch {
      /* ignore */
    }
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(PORT_DIR);
  } catch {
    // Directory does not exist yet (first activation on this machine).
    return { removed, kept };
  }
  for (const name of entries) {
    // Abandoned temp files and per-instance entries from dead windows.
    const match = PER_PID_TMP_RE.exec(name) ?? PER_PID_PORT_FILE_RE.exec(name);
    if (!match) {
      continue;
    }
    if (isOwnerAlive(Number(match[1]))) {
      kept.push(name);
    } else {
      remove(name, path.join(PORT_DIR, name));
    }
  }

  return { removed, kept };
}

export type PortFileReleaseOutcome = 'released' | 'foreign' | 'absent' | 'unreadable' | 'error';

/**
 * Remove this instance's discovery files, but only the ones that belong to it.
 *
 * The shared pointer goes through releaseLegacyPointer(); this window's own
 * per-instance entry is removed as well, provided the file still names
 * expectedPid. Fails closed on unreadable/corrupt files.
 */
export function releaseOwnedPortFile(
  expectedUri: string,
  expectedPid: number = process.pid
): PortFileReleaseOutcome {
  const outcome = releaseLegacyPointer(expectedUri, expectedPid);
  removeOwnPerPidFile(expectedPid);
  return outcome;
}

/**
 * Remove this window's per-instance entry, but only if the file names
 * expectedPid. Foreign or unreadable files are left alone (fail closed).
 */
function removeOwnPerPidFile(expectedPid: number): boolean {
  const filePath = perPidPath(expectedPid);
  const content = readPortFileAt(filePath);
  if (content === null) {
    return false;
  }
  if ('status' in content) {
    log.warn(`Per-instance port file ${path.basename(filePath)} is a stopped marker; not touching it`);
    return false;
  }
  if (content.pid !== expectedPid) {
    log.warn(
      `Per-instance port file ${path.basename(filePath)} belongs to another instance (pid ${content.pid}); not touching it`
    );
    return false;
  }
  // Mark stopped BEFORE unlinking, mirroring releaseLegacyPointer(): if the
  // unlink fails (Windows EPERM with an open reader), readers must still see a
  // stopped state — this host process stays alive after deactivate(), so a
  // live-looking leftover would keep getActiveUri() pointing at a dead server.
  if (!writeStoppedFileAt(filePath)) {
    log.warn(`Per-instance port file ${path.basename(filePath)} could not be marked stopped; removing it anyway`);
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to remove per-instance port file: ${message}`);
    return false;
  }
}

/**
 * Ownership-checked release of the shared `port.json` pointer.
 *
 * Ownership is checked BEFORE the stopped marker is written: the marker
 * replaces the live PortInfo and destroys the only ownership evidence
 * (uri + pid). Foreign live entries (other window / newer activation) are
 * left untouched. Fails closed on an unreadable/corrupt file.
 */
function releaseLegacyPointer(
  expectedUri: string,
  expectedPid: number = process.pid
): PortFileReleaseOutcome {
  const current = readPortFile();
  if (current === null) {
    let exists = false;
    try {
      exists = fs.existsSync(PORT_FILE);
    } catch {
      /* ignore */
    }
    if (exists) {
      log.warn('Port file exists but could not be read; leaving it untouched');
      return 'unreadable';
    }
    return 'absent';
  }

  if (!('status' in current) && (current.uri !== expectedUri || current.pid !== expectedPid)) {
    log.info(
      `Port file belongs to another live instance (pid ${current.pid}, ${current.uri}); not touching it`
    );
    return 'foreign';
  }

  // Ours (or already stopped): mark stopped first so readers see a stopped
  // state even if the unlink fails (Windows EPERM with an open reader).
  // The marker result is reported (arbiter M2): if the marker write fails AND
  // the unlink fails, the file still carries a live-looking PortInfo.
  const marked = writeStoppedFile();
  if (!marked) {
    log.warn('Stopped marker could not be written; removing the port file anyway');
  }
  try {
    fs.unlinkSync(PORT_FILE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to remove port file: ${message}`);
    return 'error';
  }
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
  return 'released';
}

/**
 * Low-level, unconditional removal of the discovery files. Production code
 * must call releaseOwnedPortFile() instead: this function deletes whatever is
 * on disk and MUST NOT be called without an ownership check. Kept for the
 * port-file unit tests.
 */
export function cleanupPortFile(): void {
  try {
    fs.unlinkSync(PORT_FILE);
    log.info('Port file cleaned up');
  } catch {
    // File may not exist; that's fine.
  }
  // Best-effort removal of the tmp file and this window's per-instance entry.
  for (const filePath of [TMP_FILE, PER_PID_PORT_FILE]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}
