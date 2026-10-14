import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writePortFile,
  writeStoppedFile,
  readPortFile,
  getActiveUri,
  getActivePortInfo,
  cleanupPortFile,
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
  const TMP_FILE = path.join(PORT_DIR, 'port.json.tmp');

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
});
