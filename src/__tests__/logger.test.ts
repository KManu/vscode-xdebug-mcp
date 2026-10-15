import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger';

interface FakeChannel {
  lines: string[];
  disposeCalls: number;
  throwOnDispose: boolean;
  appendLine(line: string): void;
  dispose(): void;
}

function makeFake(): FakeChannel {
  const fake: FakeChannel = {
    lines: [],
    disposeCalls: 0,
    throwOnDispose: false,
    appendLine(line: string) { fake.lines.push(line); },
    dispose() {
      fake.disposeCalls++;
      if (fake.throwOnDispose) throw new Error('dispose exploded');
    },
  };
  return fake;
}

let created: FakeChannel[];
let factoryNames: string[];
const state = () => log._getChannelStateForTesting();

function installFactory(): void {
  created = [];
  factoryNames = [];
  log._setChannelFactoryForTesting((name) => {
    factoryNames.push(name);
    const fake = makeFake();
    created.push(fake);
    return fake;
  });
}

describe('output-channel lifecycle (logger state machine)', () => {
  beforeEach(() => {
    log.dispose();               // reset latch + drop any leftover fake
    installFactory();
  });
  afterEach(() => {
    log.dispose();
    log._setChannelFactoryForTesting(undefined);
    vi.restoreAllMocks();
  });

  it('does not create a channel while disarmed (before init)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = state().unarmedLogCount;
    log.info('before arm');
    expect(factoryNames).toHaveLength(0);
    expect(log._getChannelForTesting()).toBeUndefined();
    expect(state().armed).toBe(false);
    expect(state().unarmedLogCount).toBe(before + 1);
    expect(logSpy).toHaveBeenCalledWith('[xdebug-mcp] before arm');
  });

  it('init arms; the first log creates exactly one channel and later logs reuse it', () => {
    log.init('Xdebug MCP');
    log.info('one');
    log.warn('two');
    expect(factoryNames).toHaveLength(1);
    expect(state().armed).toBe(true);
    expect(state().current).toBe(true);
    expect(created[0].lines).toHaveLength(2);
    expect(created[0].lines[1]).toContain('WARN: two');
  });

  it('dispose is idempotent: channel disposed exactly once, state cleared, never throws', () => {
    log.init('Xdebug MCP');
    log.info('armed');
    const before = state();
    log.dispose();
    log.dispose();
    expect(created[0].disposeCalls).toBe(1);
    expect(log._getChannelForTesting()).toBeUndefined();
    const after = state();
    expect(after.armed).toBe(false);
    expect(after.current).toBe(false);
    expect(after.disposeCount - before.disposeCount).toBe(1);
    expect(after.disposeFailureCount).toBe(before.disposeFailureCount);
  });

  it('a late log after dispose falls back to console and does not re-create or append', () => {
    log.init('Xdebug MCP');
    log.info('armed');
    const linesBefore = created[0].lines.length;
    log.dispose();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('late');
    expect(factoryNames).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0].lines).toHaveLength(linesBefore);
    expect(log._getChannelForTesting()).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('[xdebug-mcp] late');
  });

  it('a throwing channel.dispose never escapes and is not counted as a disposal', () => {
    log.init('Xdebug MCP');
    log.info('armed');
    created[0].throwOnDispose = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = state();
    expect(() => log.dispose()).not.toThrow();
    const after = state();
    expect(warnSpy).toHaveBeenCalled();
    expect(after.armed).toBe(false);
    expect(after.disposeFailureCount).toBe(before.disposeFailureCount + 1); // 03a OBJ-C2
    expect(after.disposeCount).toBe(before.disposeCount);                   // failed dispose not counted
    expect(log._getChannelForTesting()).toBeUndefined();
    log.init('Xdebug MCP');
    log.info('recovered');
    expect(created).toHaveLength(2);
    expect(created[1].lines).toHaveLength(1);
  });

  it('re-arm after dispose passes the new name to the factory and uses a fresh channel', () => {
    log.init('First');
    log.info('a');
    const first = created[0];
    log.dispose();
    log.init('Second');
    log.info('b');
    expect(created).toHaveLength(2);
    expect(factoryNames).toEqual(['First', 'Second']);
    expect(created[1]).not.toBe(first);
    expect(created[1].lines.some((line) => line.includes('b'))).toBe(true);
  });

  it('a stale dispose (older arming generation) is ignored, so a re-armed activation keeps its channel', () => {
    log.init('First');
    log.info('a');
    const staleEpoch = log.currentEpoch();
    log.init('Second');        // later activation re-arms while the old teardown is in flight
    log.info('b');             // the still-cached channel is reused (init does not churn)
    log.dispose(staleEpoch);   // the stale teardown's dispose must be a no-op (03a OBJ-C1)
    expect(created).toHaveLength(1);
    expect(created[0].disposeCalls).toBe(0);
    expect(log._getChannelForTesting()).toBe(created[0]);
    expect(state().armed).toBe(true);
    log.dispose();             // unconditional cleanup proves the channel was still live
    expect(created[0].disposeCalls).toBe(1);
  });

  it('falls back to console when the factory throws, and retries on the next log', () => {
    let failNext = true;
    log._setChannelFactoryForTesting(() => {
      if (failNext) { failNext = false; throw new Error('no vscode'); }
      const fake = makeFake();
      created.push(fake);
      return fake;
    });
    log.init('Xdebug MCP');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => log.info('boom')).not.toThrow();
    expect(log._getChannelForTesting()).toBeUndefined();
    expect(state().current).toBe(false);
    log.info('retry');
    expect(created).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith('[xdebug-mcp] boom');
  });
});
