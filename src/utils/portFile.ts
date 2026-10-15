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
 * Atomically write port information to the well-known file.
 * Uses write-then-rename to prevent readers from seeing partial content.
 */
export function writePortFile(info: PortInfo): void {
  try {
    fs.mkdirSync(PORT_DIR, { recursive: true });
    const json = JSON.stringify(info, null, 2);
    // Atomic write: write to tmp file, then rename (atomic on same filesystem).
    fs.writeFileSync(TMP_FILE, json, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(TMP_FILE, PORT_FILE);
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
 * Mark the port file as stopped (server is no longer running).
 */
export function writeStoppedFile(): boolean {
  try {
    fs.mkdirSync(PORT_DIR, { recursive: true });
    const info: StoppedInfo = { status: 'stopped', stopped: new Date().toISOString() };
    const json = JSON.stringify(info, null, 2);
    fs.writeFileSync(TMP_FILE, json, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(TMP_FILE, PORT_FILE);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Failed to write stopped marker: ${message}`);
    return false;
  }
}

/**
 * Read the current port file contents, or null if unavailable.
 */
export function readPortFile(): PortFileContent | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8');
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
 * Returns the active MCP URI from the port file, or null if the server is not running.
 * Validates that the PID in the file is still alive to detect stale entries.
 */
export function getActiveUri(): string | null {
  const info = readPortFile();
  if (!info || 'status' in info) {
    return null;
  }

  // Staleness check: if the recorded PID isn't alive (or is missing/invalid —
  // readPortFile normalizes to 0, which is never a real owner), treat as stopped.
  if (!isOwnerAlive(info.pid)) {
    return null;
  }

  return info.uri;
}

/**
 * Get active port information, validating PID liveness.
 */
export function getActivePortInfo(): PortInfo | null {
  const info = readPortFile();
  if (!info || 'status' in info) {
    return null;
  }
  if (!isOwnerAlive(info.pid)) {
    return null;
  }
  return info;
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
 * Readers already ignore dead-PID entries (getActiveUri/getActivePortInfo),
 * but nothing else ever removes those files: only their owner unlinks on a
 * clean stop. This is best-effort housekeeping on activate, never a
 * substitute for releaseOwnedPortFile().
 *
 * Safety rules — never throws, never touches a live instance's files:
 *  - a live entry is stale only when its PID is provably not alive;
 *  - a stopped marker is stale by definition (a live owner only writes one
 *    immediately before unlinking it);
 *  - PORT_FILE is re-read and compared (uri + pid + started) right before the
 *    unlink, so a window that replaced the entry mid-sweep keeps it;
 *  - unreadable/corrupt files and temp names without a PID are left alone
 *    (fail closed: deleting what we do not understand could race a writer).
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
    const match = PER_PID_TMP_RE.exec(name);
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
 * Remove the discovery file, but only if it belongs to this instance.
 *
 * Ownership is checked BEFORE the stopped marker is written: the marker
 * replaces the live PortInfo and destroys the only ownership evidence
 * (uri + pid). Foreign live entries (other window / newer activation) are
 * left untouched. Fails closed on an unreadable/corrupt file.
 */
export function releaseOwnedPortFile(
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
  // Best-effort removal of tmp file.
  try {
    fs.unlinkSync(TMP_FILE);
  } catch {
    /* ignore */
  }
}
