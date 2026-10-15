/**
 * Shared logger that writes to VS Code OutputChannel when available,
 * falling back to console for test environments.
 */
import type * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channel: any = undefined;
let channelName = 'Xdebug MCP';

// Lifecycle latch (gap #3): false until init() arms the logger; dispose() sets
// it false again. While disarmed, getChannel() returns undefined, so a log that
// arrives after deactivate() falls back to console and can never re-create the
// OutputChannel.
let armed = false;

// Arming generation (03a OBJ-C1): init() increments it; deactivate() captures
// the current value synchronously and only disposes if the generation is still
// current when the teardown settles. A stale teardown therefore cannot dispose
// or disarm a channel belonging to a later re-activation.
let armEpoch = 0;

// Observability counters (03a OBJ-C2, 03c O6). All four are CUMULATIVE for the
// module lifetime: log.dispose() deliberately does NOT reset them. Tests must
// assert deltas or install a fresh fake factory per test (arbiter minor #2);
// no production code reads them — only _getChannelStateForTesting().
//   createCount         — successful channel creations
//   disposeCount        — ch.dispose() calls that RETURNED
//   disposeFailureCount — ch.dispose() calls that THREW
//   unarmedLogCount     — log calls that fell back to console while disarmed
let createCount = 0;
let disposeCount = 0;
let disposeFailureCount = 0;
let unarmedLogCount = 0;

function safeConsoleWarn(message: string): void {
  try {
    console.warn(message);
  } catch {
    // 03b OBJ-3 (UNVERIFIED, U-E): during host shutdown the console RPC may be
    // unavailable. deactivate() must never reject, so there is nothing else
    // to do here.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TestChannelFactory = (name: string) => any;
// Test-only seam: vitest cannot require('vscode'), so unit tests inject fakes.
// Production leaves this undefined and uses the real VS Code module.
let channelFactoryForTesting: TestChannelFactory | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createChannel(): any {
  if (channelFactoryForTesting) return channelFactoryForTesting(channelName);
  // Dynamic require to avoid test-environment failures where vscode is mocked
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscodeModule: typeof vscode = require('vscode');
  const created = vscodeModule.window.createOutputChannel(channelName);
  try {
    // Show on first log so users see it immediately
    (created as ReturnType<typeof vscodeModule.window.createOutputChannel>).show(/* preserveFocus */ true);
  } catch (error) {
    // 03a OBJ-C4 / 03b OBJ-4: show() is cosmetic. Keep the created channel —
    // the host already retains it in its channel map, so dropping it here
    // would leak exactly the resource this change manages deterministically.
    safeConsoleWarn(
      `[xdebug-mcp] output channel show() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return created;
}

function getChannel() {
  if (!armed) {
    unarmedLogCount++;
    return undefined;
  }
  if (channel) return channel;
  try {
    channel = createChannel();
    createCount++;
  } catch {
    // Test environment / unavailable vscode module — use console fallback
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

  warn(message: string): void {
    const ch = getChannel();
    if (ch) {
      ch.appendLine(`[${timestamp()}] WARN: ${message}`);
    } else {
      console.warn(`[xdebug-mcp] ${message}`);
    }
  },

  /**
   * Activation-time hook: set the channel name and arm (or re-arm) logging.
   * Called from activate(); stays lazy — it never creates the channel here.
   * Increments the arming generation so an in-flight teardown belonging to a
   * previous activation cannot dispose this activation's channel.
   */
  init(name: string): void {
    channelName = name;
    armed = true;
    armEpoch++;
  },

  /** Current arming generation; deactivate() captures it before awaiting. */
  currentEpoch(): number {
    return armEpoch;
  },

  /**
   * Deterministically release the OutputChannel. Idempotent and never throws.
   * The cache is cleared and logging disarmed BEFORE ch.dispose() so a late log
   * can neither reuse the disposed channel (which throws "Channel has been
   * closed") nor create a new one. init() re-arms for a later activation.
   *
   * When `epoch` is provided, disposal is skipped unless it still matches the
   * current arming generation (03a OBJ-C1).
   */
  dispose(epoch?: number): void {
    if (epoch !== undefined && epoch !== armEpoch) return;
    const ch = channel;
    channel = undefined;
    armed = false;
    if (!ch) return;
    try {
      ch.dispose();
      disposeCount++; // 03a OBJ-C2: only a dispose that RETURNED counts as done
    } catch (error) {
      disposeFailureCount++;
      safeConsoleWarn(
        `[xdebug-mcp] output channel dispose failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },

  /** Expose channel for tests to inspect. */
  _getChannelForTesting(): typeof channel {
    return channel;
  },

  /** Test-only read-only view of the logger lifecycle state. Never mutates. */
  _getChannelStateForTesting(): {
    armed: boolean;
    current: boolean;
    createCount: number;
    disposeCount: number;
    disposeFailureCount: number;
    unarmedLogCount: number;
  } {
    return {
      armed,
      current: channel !== undefined,
      createCount,
      disposeCount,
      disposeFailureCount,
      unarmedLogCount,
    };
  },

  /** Test-only: inject a fake channel factory (vitest cannot require 'vscode'). */
  _setChannelFactoryForTesting(factory: TestChannelFactory | undefined): void {
    channelFactoryForTesting = factory;
  },
};
