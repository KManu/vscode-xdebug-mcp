import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  writePortFile,
  writeStoppedFile,
  readPortFile,
  getActiveUri,
  getActivePortInfo,
  cleanupPortFile,
  releaseOwnedPortFile,
  sweepStalePortFiles,
  TMP_FILE,
} from '../utils/portFile';

// We test the real port file module by monkey-patching the port dir to a temp location.
// The module constants are at module level, so we override via process.env or by
// manipulating fs behavior. Instead, we test the read/write cycle using the actual
// functions, then clean up.

// The port dir is redirected per-fork by src/__tests__/setup.ts via
// XDEBUG_MCP_PORT_DIR, so tests never touch the real ~/.vscode-xdebug-mcp.
const testPortDir =
  process.env.XDEBUG_MCP_PORT_DIR || path.join(os.tmpdir(), 'vscode-xdebug-mcp-test-' + process.pid);

describe('portFile', () => {
  const PORT_DIR = testPortDir;
  const PORT_FILE = path.join(PORT_DIR, 'port.json');

  beforeEach(() => {
    // Clean up from any previous test run
    cleanupPortFile();
  });

  afterEach(() => {
    // Clean up test artifacts
    cleanupPortFile();
  });

  describe('writePortFile and readPortFile', () => {
    it('should write and read port info atomically', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      // Temp file should be gone (atomic rename consumed it)
      expect(() => fs.statSync(TMP_FILE)).toThrow();

      const info = readPortFile();
      expect(info).not.toBeNull();
      if (info && 'uri' in info) {
        expect(info.uri).toBe('http://127.0.0.1:3098/mcp');
        expect(info.host).toBe('127.0.0.1');
        expect(info.port).toBe(3098);
        expect(info.version).toBe('1.0.0');
        expect(info.pid).toBe(process.pid);
        expect(typeof info.started).toBe('string');
      }
    });

    it('should return null when port file does not exist', () => {
      const info = readPortFile();
      expect(info).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, 'not json', 'utf8');
      const info = readPortFile();
      expect(info).toBeNull();
    });

    it('should return null for JSON with missing required fields', () => {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, JSON.stringify({ foo: 'bar' }), 'utf8');
      const info = readPortFile();
      expect(info).toBeNull();
    });

    it('should overwrite on multiple writes (last write wins)', () => {
      writePortFile({
        uri: 'http://127.0.0.1:4000/mcp',
        host: '127.0.0.1',
        port: 4000,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      writePortFile({
        uri: 'http://127.0.0.1:5000/mcp',
        host: '127.0.0.1',
        port: 5000,
        version: '2.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      const info = readPortFile() as { port: number; version: string } | null;
      expect(info).not.toBeNull();
      if (info && 'port' in info) {
        expect(info.port).toBe(5000);
        expect(info.version).toBe('2.0.0');
      }
    });
  });

  describe('writeStoppedFile', () => {
    it('should write stopped status', () => {
      // First write a running status
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      // Then mark as stopped
      writeStoppedFile();

      const info = readPortFile();
      expect(info).not.toBeNull();
      if (info && 'status' in info) {
        expect(info.status).toBe('stopped');
        expect(typeof info.stopped).toBe('string');
      }
    });

    it('should work even if no prior port file existed', () => {
      writeStoppedFile();
      const info = readPortFile();
      expect(info).not.toBeNull();
      if (info && 'status' in info) {
        expect(info.status).toBe('stopped');
      }
    });
  });

  describe('getActiveUri', () => {
    it('should return the URI when server is running (PID matches)', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      const uri = getActiveUri();
      expect(uri).toBe('http://127.0.0.1:3098/mcp');
    });

    it('should return null when status is stopped', () => {
      writeStoppedFile();
      const uri = getActiveUri();
      expect(uri).toBeNull();
    });

    it('should return null when PID is not alive (stale file)', () => {
      // Use PID 1 (init) or a very high unlikely PID
      const fakePid = 99999;
      // Verify fake PID is not alive
      let fakePidAlive = false;
      try {
        process.kill(fakePid, 0);
        fakePidAlive = true;
      } catch {
        /* expected */
      }

      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: fakePid,
        started: new Date().toISOString(),
      });

      if (fakePidAlive) {
        // If the fake PID happens to be alive (unlikely), skip the assertion
        // The URI would be returned since PID is alive
        const uri = getActiveUri();
        expect(typeof uri).toBe('string');
      } else {
        const uri = getActiveUri();
        expect(uri).toBeNull();
      }
    });

    it('should return null when no file exists', () => {
      const uri = getActiveUri();
      expect(uri).toBeNull();
    });
  });

  describe('getActivePortInfo', () => {
    it('should return full PortInfo when server is running', () => {
      writePortFile({
        uri: 'http://127.0.0.1:45678/mcp',
        host: '127.0.0.1',
        port: 45678,
        version: '2.1.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      const info = getActivePortInfo();
      expect(info).not.toBeNull();
      if (info) {
        expect(info.uri).toBe('http://127.0.0.1:45678/mcp');
        expect(info.port).toBe(45678);
        expect(info.version).toBe('2.1.0');
        expect(info.pid).toBe(process.pid);
      }
    });

    it('should return null when status is stopped', () => {
      writeStoppedFile();
      const info = getActivePortInfo();
      expect(info).toBeNull();
    });
  });

  describe('cleanupPortFile', () => {
    it('should remove the port file', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      expect(() => fs.statSync(PORT_FILE)).not.toThrow();
      cleanupPortFile();
      expect(() => fs.statSync(PORT_FILE)).toThrow();
    });

    it('should not throw if file does not exist', () => {
      expect(() => cleanupPortFile()).not.toThrow();
    });
  });

  describe('releaseOwnedPortFile', () => {
    it('returns foreign and leaves a foreign live entry intact (pid 999999)', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: 999999,
        started: new Date().toISOString(),
      });

      const outcome = releaseOwnedPortFile('http://127.0.0.1:3098/mcp', process.pid);
      expect(outcome).toBe('foreign');

      // File intact, no status field, still the foreign live entry.
      const info = readPortFile();
      expect(info).not.toBeNull();
      expect(info && 'status' in info).toBe(false);
      if (info && !('status' in info)) {
        expect(info.pid).toBe(999999);
        expect(info.uri).toBe('http://127.0.0.1:3098/mcp');
      }
    });

    it('returns foreign for the same URI but a different PID', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: 999999,
        started: new Date().toISOString(),
      });

      const outcome = releaseOwnedPortFile('http://127.0.0.1:3098/mcp', 888888);
      expect(outcome).toBe('foreign');
      expect(fs.existsSync(PORT_FILE)).toBe(true);
    });

    it('releases its own entry and removes the file', () => {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid: process.pid,
        started: new Date().toISOString(),
      });

      const outcome = releaseOwnedPortFile('http://127.0.0.1:3098/mcp', process.pid);
      expect(outcome).toBe('released');
      expect(readPortFile()).toBeNull();
    });

    it('returns unreadable for a corrupt file and leaves it intact', () => {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, 'not json', 'utf8');

      const outcome = releaseOwnedPortFile('http://127.0.0.1:3098/mcp', process.pid);
      expect(outcome).toBe('unreadable');
      expect(fs.existsSync(PORT_FILE)).toBe(true);
    });
  });

  describe('per-process temp file', () => {
    it('uses a per-PID temp name', () => {
      expect(path.basename(TMP_FILE)).toBe(`port.json.${process.pid}.tmp`);
    });

    it('leaves a foreign per-PID temp file alone across a write/release cycle', () => {
      const foreignTmp = path.join(PORT_DIR, 'port.json.999999.tmp');
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(foreignTmp, 'foreign', 'utf8');

      try {
        writePortFile({
          uri: 'http://127.0.0.1:3098/mcp',
          host: '127.0.0.1',
          port: 3098,
          version: '1.0.0',
          pid: process.pid,
          started: new Date().toISOString(),
        });
        releaseOwnedPortFile('http://127.0.0.1:3098/mcp', process.pid);

        expect(fs.existsSync(foreignTmp)).toBe(true);
      } finally {
        try {
          fs.unlinkSync(foreignTmp);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe('sweepStalePortFiles', () => {
    /**
     * A PID that is guaranteed dead: spawnSync waits for the helper process to
     * exit before returning. The aliveness assertion guards against exotic PID
     * reuse between the helper's exit and the sweep.
     */
    function deadPid(): number {
      const child = spawnSync(process.execPath, ['-e', '']);
      const pid = child.pid;
      if (typeof pid !== 'number' || pid <= 0) {
        throw new Error('spawnSync did not report a helper PID');
      }
      expect(() => process.kill(pid, 0)).toThrow();
      return pid;
    }

    function writeLiveEntry(pid: number): void {
      writePortFile({
        uri: 'http://127.0.0.1:3098/mcp',
        host: '127.0.0.1',
        port: 3098,
        version: '1.0.0',
        pid,
        started: new Date().toISOString(),
      });
    }

    it('removes a dead-PID entry, reports it, and is idempotent', () => {
      writeLiveEntry(deadPid());

      const first = sweepStalePortFiles();
      expect(first.removed).toContain('port.json');
      expect(fs.existsSync(PORT_FILE)).toBe(false);

      const second = sweepStalePortFiles();
      expect(second.removed).toEqual([]);
    });

    it('keeps a live entry owned by this process', () => {
      writeLiveEntry(process.pid);

      const result = sweepStalePortFiles();
      expect(result.removed).toEqual([]);
      expect(fs.existsSync(PORT_FILE)).toBe(true);
    });

    it('removes a stopped marker left behind by a failed unlink', () => {
      expect(writeStoppedFile()).toBe(true);

      const result = sweepStalePortFiles();
      expect(result.removed).toContain('port.json');
      expect(fs.existsSync(PORT_FILE)).toBe(false);
    });

    it('removes temp files abandoned by dead PIDs and keeps live ones', () => {
      const deadTmp = path.join(PORT_DIR, `port.json.${deadPid()}.tmp`);
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(deadTmp, 'abandoned', 'utf8');
      fs.writeFileSync(TMP_FILE, 'in-progress', 'utf8');

      const result = sweepStalePortFiles();
      expect(result.removed).toContain(path.basename(deadTmp));
      expect(fs.existsSync(deadTmp)).toBe(false);
      expect(fs.existsSync(TMP_FILE)).toBe(true);
    });

    it('leaves corrupt files and legacy temp names alone (fail closed)', () => {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, 'not json', 'utf8');
      const legacyTmp = path.join(PORT_DIR, 'port.json.tmp');
      fs.writeFileSync(legacyTmp, 'legacy', 'utf8');

      try {
        const result = sweepStalePortFiles();
        expect(result.removed).toEqual([]);
        expect(fs.existsSync(PORT_FILE)).toBe(true);
        expect(fs.existsSync(legacyTmp)).toBe(true);
      } finally {
        try {
          fs.unlinkSync(legacyTmp);
        } catch {
          /* ignore */
        }
      }
    });

    it('treats a pid-less entry as dead in readers and sweeps it', () => {
      fs.mkdirSync(PORT_DIR, { recursive: true });
      fs.writeFileSync(
        PORT_FILE,
        JSON.stringify({
          uri: 'http://127.0.0.1:3098/mcp',
          host: '127.0.0.1',
          port: 3098,
          version: '1.0.0',
          started: new Date().toISOString(),
        }),
        'utf8'
      );
      // Missing pid is normalized to 0 by readPortFile; 0 must never count as a
      // live owner (process.kill(0) targets this process's group, no throw).
      expect(readPortFile()).toMatchObject({ pid: 0 });
      expect(getActiveUri()).toBeNull();
      expect(getActivePortInfo()).toBeNull();

      const result = sweepStalePortFiles();
      expect(result.removed).toContain('port.json');
      expect(fs.existsSync(PORT_FILE)).toBe(false);
    });

    it('is a no-op when the port directory does not exist', () => {
      fs.rmSync(PORT_DIR, { recursive: true, force: true });
 
      expect(sweepStalePortFiles()).toEqual({ removed: [], kept: [] });
    });
  });
});
