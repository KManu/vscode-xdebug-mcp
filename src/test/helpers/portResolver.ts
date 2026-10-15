// src/test/helpers/portResolver.ts
// Shared port resolution helper for integration tests.
// Polls the discovery directory (~/.vscode-xdebug-mcp/) until a live, running
// server is detected.
//
// Discovery contract (mirrors src/utils/portFile.ts):
// - `port.json` is the shared, last-writer-wins pointer (kept for backward
//   compatibility with older readers).
// - `port.<pid>.json` is one window's own entry; it survives another window
//   overwriting the shared pointer.
// A live entry is one whose owner PID is alive (process.kill(pid, 0)).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface PortInfo {
  port: number;
  host: string;
  uri: string;
  version: string;
  pid: number;
  started: string;
}

const PORT_DIR = process.env.XDEBUG_MCP_PORT_DIR || path.join(os.homedir(), '.vscode-xdebug-mcp');
const PORT_FILE = path.join(PORT_DIR, 'port.json');
const PER_PID_PORT_FILE_RE = /^port\.(\d+)\.json$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse one discovery file's contents, or null when it is not a live entry. */
function parseEntry(raw: string): PortInfo | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.status === 'stopped') {
    return null;
  }
  if (typeof parsed.port !== 'number' || typeof parsed.host !== 'string' || typeof parsed.uri !== 'string') {
    return null;
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  if (!pidAlive(pid)) {
    return null;
  }
  return {
    port: parsed.port,
    host: parsed.host,
    uri: parsed.uri,
    version: String(parsed.version ?? '0.0.1'),
    pid,
    started: String(parsed.started ?? ''),
  };
}

/**
 * All live discovery entries (shared pointer + per-instance files), newest
 * first and de-duplicated by PID.
 */
export function listLivePortInfos(): PortInfo[] {
  const byPid = new Map<number, PortInfo>();
  const consider = (raw: string | null): void => {
    if (raw === null) {
      return;
    }
    const info = parseEntry(raw);
    if (info !== null && !byPid.has(info.pid)) {
      byPid.set(info.pid, info);
    }
  };

  try {
    consider(fs.readFileSync(PORT_FILE, 'utf8'));
  } catch {
    // File doesn't exist yet.
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(PORT_DIR);
  } catch {
    // Directory doesn't exist yet.
  }
  for (const name of names) {
    if (!PER_PID_PORT_FILE_RE.test(name)) {
      continue;
    }
    try {
      consider(fs.readFileSync(path.join(PORT_DIR, name), 'utf8'));
    } catch {
      // File disappeared mid-scan.
    }
  }

  return [...byPid.values()].sort((a, b) => {
    if (a.started !== b.started) {
      return a.started < b.started ? 1 : -1;
    }
    return b.pid - a.pid;
  });
}

/**
 * Polls the discovery files until at least one live server is found and
 * returns the newest live entry.
 *
 * Handles: missing files (server hasn't started yet), `status: 'stopped'`
 * markers (shutdown in progress, may restart) and dead-PID stale entries.
 *
 * @param maxWaitMs     Maximum time to wait (default 10s).
 * @param pollIntervalMs Interval between polls (default 200ms).
 */
export async function getServerPort(maxWaitMs = 10000, pollIntervalMs = 200): Promise<PortInfo> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const live = listLivePortInfos();
    if (live.length > 0) {
      return live[0];
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for a live discovery entry after ${maxWaitMs}ms`);
}
