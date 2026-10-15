import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 03b OBJ-1 / 03a OBJ-C1: these behaviors (rejecting teardown, deferred teardown)
// are not reachable through VS Code, so they are injected here, file-locally.
const teardownControl = vi.hoisted(() => ({
  reject: false,
  defer: false,
  releaseDeferred: undefined as (() => void) | undefined,
}));

vi.mock('../mcp/httpTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/httpTransport')>();
  return {
    ...actual,
    stopHttpServer: () => {
      if (teardownControl.reject) return Promise.reject(new Error('teardown exploded'));
      if (teardownControl.defer) {
        return new Promise<void>((resolve) => { teardownControl.releaseDeferred = resolve; });
      }
      return actual.stopHttpServer();
    },
  };
});

import { deactivate } from '../extension';
import { log } from '../utils/logger';

interface FakeChannel {
  lines: string[];
  disposeCalls: number;
  appendLine(line: string): void;
  dispose(): void;
}

let fakes: FakeChannel[];

function makeFake(): FakeChannel {
  const fake: FakeChannel = {
    lines: [],
    disposeCalls: 0,
    appendLine(line: string) { fake.lines.push(line); },
    dispose() { fake.disposeCalls++; },
  };
  return fake;
}

describe('deactivate() -> logger disposal wiring', () => {
  beforeEach(() => {
    teardownControl.reject = false;
    teardownControl.defer = false;
    teardownControl.releaseDeferred = undefined;
    log.dispose();
    fakes = [];
    log._setChannelFactoryForTesting(() => {
      const fake = makeFake();
      fakes.push(fake);
      return fake;
    });
  });
  afterEach(async () => {
    teardownControl.reject = false;
    teardownControl.defer = false;
    await Promise.resolve(deactivate());          // leave module disarmed
    log._setChannelFactoryForTesting(undefined);
    vi.restoreAllMocks();
  });

  it('disposes the live channel exactly once and never rejects on double invocation', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    expect(fakes).toHaveLength(1);
    const results = await Promise.allSettled([Promise.resolve(deactivate()), Promise.resolve(deactivate())]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fakes[0].disposeCalls).toBe(1);
    expect(log._getChannelForTesting()).toBeUndefined();
    expect(log._getChannelStateForTesting().armed).toBe(false);
  });

  it('disposes only AFTER the teardown promise settles (03c O2)', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    const p = Promise.resolve(deactivate());
    // Synchronously after deactivate() returns, disposal must not have run:
    // a dispose-at-entry implementation fails here.
    expect(fakes[0].disposeCalls).toBe(0);
    await p;
    expect(fakes[0].disposeCalls).toBe(1);
  });

  it('a late log after deactivate falls back to console and does not re-create', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    await Promise.allSettled([Promise.resolve(deactivate())]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('late');
    expect(fakes).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith('[xdebug-mcp] late');
    expect(log._getChannelForTesting()).toBeUndefined();
  });

  it('re-arm after deactivate creates a fresh channel', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    await Promise.allSettled([Promise.resolve(deactivate())]);
    log.init('Xdebug MCP');
    log.info('rearmed');
    expect(fakes).toHaveLength(2);
    expect(fakes[0].disposeCalls).toBe(1);
    expect(fakes[1].lines).toHaveLength(1);
  });

  it('a stale teardown does not disarm a re-armed logger (03a OBJ-C1)', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    teardownControl.defer = true;
    const p = Promise.resolve(deactivate());   // captures the current epoch
    log.init('Xdebug MCP');                    // simulates a re-activation during teardown
    expect(teardownControl.releaseDeferred).toBeDefined();
    teardownControl.releaseDeferred!();
    await p;
    expect(fakes[0].disposeCalls).toBe(0);     // stale teardown must not dispose
    expect(log._getChannelForTesting()).toBe(fakes[0]);
    expect(log._getChannelStateForTesting().armed).toBe(true);
    // afterEach's deactivate() captures the new epoch and performs the real disposal.
  });

  it('a rejecting teardown is swallowed: deactivate() fulfills and still disposes (03b OBJ-1)', async () => {
    log.init('Xdebug MCP');
    log.info('armed');
    teardownControl.reject = true;
    const results = await Promise.allSettled([Promise.resolve(deactivate())]);
    expect(results[0].status).toBe('fulfilled');
    expect(fakes[0].disposeCalls).toBe(1);
    expect(log._getChannelForTesting()).toBeUndefined();
  });
});
