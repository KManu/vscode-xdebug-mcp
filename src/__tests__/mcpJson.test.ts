import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readWorkspaceMcpJson,
  addXdebugToMcpJson,
  previewMcpJsonChange,
  writeWorkspaceMcpJson,
} from '../utils/mcpJson';

const testRoot = path.join(os.tmpdir(), 'xdebug-mcp-test-workspace-' + process.pid);
const vscodeDir = path.join(testRoot, '.vscode');
const mcpPath = path.join(vscodeDir, 'mcp.json');

describe('mcpJson', () => {
  beforeEach(() => {
    // Clean and create fresh test workspace
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  describe('readWorkspaceMcpJson', () => {
    it('should return null when file does not exist', () => {
      const result = readWorkspaceMcpJson(testRoot);
      expect(result).toBeNull();
    });

    it('should parse valid JSON', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(
        mcpPath,
        JSON.stringify({ servers: { other: { type: 'http', url: 'http://example.com' } } }),
        'utf8'
      );
      const result = readWorkspaceMcpJson(testRoot);
      expect(result).not.toBeNull();
      expect(result).toEqual({ servers: { other: { type: 'http', url: 'http://example.com' } } });
    });

    it('should return null for non-object JSON (array)', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(mcpPath, JSON.stringify([1, 2, 3]), 'utf8');
      const result = readWorkspaceMcpJson(testRoot);
      expect(result).toBeNull();
    });

    it('should return null for malformed JSON', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(mcpPath, 'not { valid json', 'utf8');
      const result = readWorkspaceMcpJson(testRoot);
      expect(result).toBeNull();
    });
  });

  describe('addXdebugToMcpJson', () => {
    it('should add xdebug entry to empty config', () => {
      const { config, isNew } = addXdebugToMcpJson(null, 'http://127.0.0.1:3098/mcp');
      expect(isNew).toBe(true);
      expect(config).toEqual({
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });

    it('should add xdebug entry alongside existing servers', () => {
      const existing = {
        servers: {
          other: { type: 'http', url: 'http://example.com/mcp' },
        },
      };
      const { config, isNew } = addXdebugToMcpJson(existing, 'http://127.0.0.1:3098/mcp');
      expect(isNew).toBe(true);
      expect(config).toEqual({
        servers: {
          other: { type: 'http', url: 'http://example.com/mcp' },
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });

    it('should update existing xdebug entry', () => {
      const existing = {
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:4000/mcp' },
        },
      };
      const { config, isNew } = addXdebugToMcpJson(existing, 'http://127.0.0.1:3098/mcp');
      expect(isNew).toBe(false);
      expect(config).toEqual({
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });

    it('should preserve non-servers keys', () => {
      const existing = {
        inputs: [{ type: 'promptString', id: 'token', description: 'API Token' }],
        servers: {},
      };
      const { config, isNew } = addXdebugToMcpJson(existing, 'http://127.0.0.1:3098/mcp');
      expect(isNew).toBe(true);
      expect(config).toEqual({
        inputs: [{ type: 'promptString', id: 'token', description: 'API Token' }],
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });
  });

  describe('previewMcpJsonChange', () => {
    it('should show new file preview when no .vscode/mcp.json exists', () => {
      const result = previewMcpJsonChange(testRoot, 'http://127.0.0.1:3098/mcp');
      if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.isNewFile).toBe(true);
      expect(result.before).toBe('(new file)');
      expect(JSON.parse(result.after)).toEqual({
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });

    it('should show update preview when .vscode/mcp.json exists', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(mcpPath, JSON.stringify({ servers: { other: { type: 'stdio', command: 'node' } } }), 'utf8');

      const result = previewMcpJsonChange(testRoot, 'http://127.0.0.1:3098/mcp');
      if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.isNewFile).toBe(false);
      expect(JSON.parse(result.after)).toEqual({
        servers: {
          other: { type: 'stdio', command: 'node' },
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });
  });

  describe('writeWorkspaceMcpJson', () => {
    it('should create .vscode directory and mcp.json when neither exist', () => {
      const ok = writeWorkspaceMcpJson(testRoot, 'http://127.0.0.1:3098/mcp');
      expect(ok).toBe(true);

      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });

    it('should update existing mcp.json without losing other servers', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(
        mcpPath,
        JSON.stringify({
          servers: {
            playwright: { type: 'stdio', command: 'npx' },
          },
        }),
        'utf8'
      );

      const ok = writeWorkspaceMcpJson(testRoot, 'http://127.0.0.1:4000/mcp');
      expect(ok).toBe(true);

      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.servers).toEqual({
        playwright: { type: 'stdio', command: 'npx' },
        xdebug: { type: 'http', url: 'http://127.0.0.1:4000/mcp' },
      });
    });

    it('should update xdebug URL when it already exists', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(
        mcpPath,
        JSON.stringify({
          servers: {
            xdebug: { type: 'http', url: 'http://127.0.0.1:5000/mcp' },
          },
        }),
        'utf8'
      );

      const ok = writeWorkspaceMcpJson(testRoot, 'http://127.0.0.1:6000/mcp');
      expect(ok).toBe(true);

      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect((parsed.servers as Record<string, unknown>).xdebug).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:6000/mcp',
      });
    });

    it('should handle malformed existing mcp.json gracefully', () => {
      fs.mkdirSync(vscodeDir, { recursive: true });
      fs.writeFileSync(mcpPath, 'not valid json', 'utf8');

      // readWorkspaceMcpJson returns null for invalid JSON,
      // which means addXdebugToMcpJson treats it as empty and creates fresh.
      const ok = writeWorkspaceMcpJson(testRoot, 'http://127.0.0.1:3098/mcp');
      expect(ok).toBe(true);

      const raw = fs.readFileSync(mcpPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({
        servers: {
          xdebug: { type: 'http', url: 'http://127.0.0.1:3098/mcp' },
        },
      });
    });
  });
});
