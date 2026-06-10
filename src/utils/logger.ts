/**
 * Shared logger that writes to VS Code OutputChannel when available,
 * falling back to console for test environments.
 */
import type * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channel: any = undefined;
let channelName = 'Xdebug MCP';

function getChannel() {
  if (channel) return channel;
  try {
    // Dynamic require to avoid test-environment failures where vscode is mocked
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscodeModule: typeof vscode = require('vscode');
    channel = vscodeModule.window.createOutputChannel(channelName);
    // Show on first log so users see it immediately
    (channel as ReturnType<typeof vscodeModule.window.createOutputChannel>).show(/* preserveFocus */ true);
  } catch {
    // Test environment — use console fallback
    channel = undefined;
  }
  return channel;
}

function timestamp(): string {
  return new Date().toISOString().split('T')[1]?.slice(0, 12) ?? '';
}

export const log = {
  info(message: string): void {
    const ch = getChannel();
    if (ch) {
      ch.appendLine(`[${timestamp()}] ${message}`);
    } else {
      console.log(`[xdebug-mcp] ${message}`);
    }
  },

  error(message: string): void {
    const ch = getChannel();
    if (ch) {
      ch.appendLine(`[${timestamp()}] ERROR: ${message}`);
    } else {
      console.error(`[xdebug-mcp] ${message}`);
    }
  },

  /** Call once during extension activation to set the channel name. */
  init(name: string): void {
    channelName = name;
  },

  /** Expose channel for tests to inspect. */
  _getChannelForTesting(): typeof channel {
    return channel;
  },
};
