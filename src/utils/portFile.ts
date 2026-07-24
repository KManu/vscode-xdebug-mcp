import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { log } from './logger';

const PORT_DIR = path.join(os.homedir(), '.vscode-xdebug-mcp');
const PORT_FILE = path.join(PORT_DIR, 'port.json');
const TMP_FILE = path.join(PORT_DIR, 'port.json.tmp');

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
export function writeStoppedFile(): void {
  try {
    fs.mkdirSync(PORT_DIR, { recursive: true });
    const info: StoppedInfo = {
      status: 'stopped',
      stopped: new Date().toISOString(),
    };
    const json = JSON.stringify(info, null, 2);
    fs.writeFileSync(TMP_FILE, json, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(TMP_FILE, PORT_FILE);
  } catch {
    // Best-effort; port file cleanup is not critical.
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

  // Staleness check: if the recorded PID isn't alive, treat as stopped.
  if (!isPidAlive(info.pid)) {
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
  if (!isPidAlive(info.pid)) {
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
 * Remove the port file entirely. Called on extension deactivate.
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
