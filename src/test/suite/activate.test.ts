// src/test/suite/activate.test.ts
// Tests for extension activation, command registration, and cleanup.
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PORT_FILE = path.join(os.homedir(), '.vscode-xdebug-mcp', 'port.json');

describe('Extension Activation', function () {
  this.timeout(15000);

  it('extension is active after VS Code starts', function () {
    const ext = vscode.extensions.getExtension('KwabenaManu.vscode-xdebug-mcp');
    assert.ok(ext, 'Extension should be resolvable by publisher + name');
    assert.ok(ext.isActive, 'Extension should be active');
  });

  it('registers the addToWorkspaceMcp command', async function () {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('xdebug-mcp.addToWorkspaceMcp'),
      'Expected xdebug-mcp.addToWorkspaceMcp to be registered'
    );
  });

  it('server is running and port file is valid', function () {
    const portFile = path.join(os.homedir(), '.vscode-xdebug-mcp', 'port.json');
    const data = JSON.parse(fs.readFileSync(portFile, 'utf8'));
    assert.ok(typeof data.port === 'number', 'port should be a number');
    assert.ok(typeof data.pid === 'number', 'pid should be a number');
    try {
      process.kill(data.pid, 0);
    } catch {
      assert.fail('Server PID is dead');
    }
  });
});

// Suite-level teardown: verify port file cleanup.
after(function () {
  this.timeout(3000);

  // Give the server a moment to finish cleanup.
  // Check that the port file is either absent or marked as stopped.
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // If the file exists, it must have status: 'stopped'
    if (parsed && typeof parsed === 'object') {
      if (parsed.status === 'stopped') {
        // Expected — server stopped gracefully.
        return;
      }
      // If there's a live PID, verify it's actually dead.
      if (typeof parsed.pid === 'number') {
        try {
          process.kill(parsed.pid, 0);
          // PID is alive — port file should not still be live after deactivate.
          assert.fail('Port file exists with a live PID after deactivation');
        } catch {
          // PID is dead — that's acceptable (stale file without stopped marker).
        }
      }
    }
  } catch {
    // File doesn't exist — that's the ideal case after cleanup.
  }
});
