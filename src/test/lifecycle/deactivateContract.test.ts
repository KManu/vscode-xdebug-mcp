// src/test/lifecycle/deactivateContract.test.ts
// Runs ONLY via `npm run test:e2e:lifecycle` (default glob does not match this
// directory; the lifecycle runner isolates XDEBUG_MCP_PORT_DIR).
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getServerPort } from '../helpers/portResolver';

const EXTENSION_ID = 'KwabenaManu.vscode-xdebug-mcp';
const DEACTIVATE_BUDGET_MS = 3000;
const SEVER_BUDGET_MS = 1000;

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await delay(100);
    }
    return predicate();
  })();
}

interface LiveChannel {
  appendLine(line: string): void;
  dispose(): void;
}

interface LiveLoggerState {
  armed: boolean;
  current: boolean;
  createCount: number;
  disposeCount: number;
  disposeFailureCount: number;
  unarmedLogCount: number;
}

interface LiveLogger {
  info(message: string): void;
  init(name: string): void;
  _getChannelForTesting(): unknown;
  _getChannelStateForTesting(): LiveLoggerState;
}

interface LiveExtensionModule {
  deactivate?: () => unknown;
  _getTeardownStateForTesting?: () => Record<string, unknown>;
  _logForTesting?: LiveLogger;
}

function loadLiveExtensionModule(): LiveExtensionModule {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension must be resolvable');
  const bundlePath = path.join(ext.extensionPath, 'dist', 'extension.js');
  // Windows casing trap: ext.extensionPath may be `C:\...` while the host's
  // require-cache key is `c:\...`. Match case-insensitively, but require a
  // single unambiguous match; a second module instance would make deactivate()
  // a false green (evidence t1).
  const matches = Object.keys(require.cache).filter(
    (k) => k.toLowerCase() === bundlePath.toLowerCase()
  );
  assert.strictEqual(matches.length, 1, `expected exactly one require.cache entry for ${bundlePath}, found ${matches.length}`);
  const mod = require(matches[0]) as LiveExtensionModule;
  assert.strictEqual(typeof mod.deactivate, 'function', 'live bundle must export deactivate');
  return mod;
}

interface HeldSse { req: http.ClientRequest; res: http.IncomingMessage; closed: () => boolean; }

function holdSseStream(port: number): Promise<HeldSse> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/mcp', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) { reject(new Error(`GET /mcp expected 200, got ${res.statusCode}`)); return; }
        let closed = false;
        res.on('close', () => { closed = true; });
        res.on('end', () => { closed = true; });
        res.on('data', () => {});
        res.on('error', () => { /* the fix force-closes this socket */ });
        resolve({ req, res, closed: () => closed });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('test client timeout')));
  });
}

function tcpProbe(port: number): Promise<'connected' | 'refused' | 'timeout'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => { socket.destroy(); resolve('timeout'); });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', () => { socket.destroy(); resolve('refused'); });
  });
}

describe('Xdebug MCP deactivate contract (in-host)', function () {
  this.timeout(30000);
  let sse: HeldSse | undefined;

  after(async function () {
    this.timeout(5000);
    sse?.req.destroy();
    await delay(200);
  });

  it('settles deactivate(), severs the held SSE, and removes the discovery files', async function () {
    // H3 guard: fail loudly instead of silently using the real ~/.vscode-xdebug-mcp.
    assert.strictEqual(process.env.XDEBUG_MCP_LIFECYCLE, '1',
      'run via `npm run test:e2e:lifecycle` (direct vscode-test invocations must set XDEBUG_MCP_PORT_DIR and XDEBUG_MCP_LIFECYCLE=1)');
    const portDir = process.env.XDEBUG_MCP_PORT_DIR;
    assert.ok(portDir, 'XDEBUG_MCP_PORT_DIR must be set by the lifecycle config');
    const portFile = path.join(portDir, 'port.json');
    const perPidFile = path.join(portDir, `port.${process.pid}.json`);

    const info = await getServerPort();
    assert.strictEqual(info.host, '127.0.0.1');
    // The test runs inside the extension host, so the entry must be ours.
    assert.strictEqual(info.pid, process.pid, 'port file must belong to this extension host');
    // Multi-window contract: this window must also have published its own
    // per-instance entry (`port.<pid>.json`), not just the shared pointer.
    assert.ok(fs.existsSync(perPidFile), 'per-instance discovery file must exist while the server runs');

    // 1. Hold a real GET /mcp SSE stream: the condition that blocks the old
    //    server.close(cb) path.
    sse = await holdSseStream(info.port);
    await delay(300);
    assert.strictEqual(sse.res.complete, false, 'SSE stream must still be open at deactivate time');

    // 2. Drive the REAL module instance twice — the host's deactivate() and the
    //    subscription disposable both call stopHttpServer() (extension.ts:239-243).
    const mod = loadLiveExtensionModule();

    // ── Output-channel disposal contract (gap #3) ────────────────────────
    // 03c O1: every criterion is collected first and asserted once at the end
    // of block (d), so one red run reports ALL violations, not just the first.
    const problems: string[] = [];

    // The live bundle's logger is reachable only through the re-export:
    // importing src/utils/logger here would be a DIFFERENT module instance
    // than the bundle's inlined logger (module-identity trap).
    if (typeof mod._logForTesting !== 'object' || mod._logForTesting === null) {
      throw new assert.AssertionError({
        message: 'bundle must re-export the logger as _logForTesting (extension.ts)',
      });
    }
    const liveLog: LiveLogger = mod._logForTesting;
    // 03c O1 red staging: on the pre-fix logger the state accessor is absent.
    // Guard it so a red run still observes (b)/(c)/(d) instead of throwing.
    const readState = (): LiveLoggerState | undefined =>
      typeof liveLog._getChannelStateForTesting === 'function'
        ? liveLog._getChannelStateForTesting()
        : undefined;

    const ch1 = liveLog._getChannelForTesting() as LiveChannel | undefined;
    if (!ch1 || typeof ch1.appendLine !== 'function' || typeof ch1.dispose !== 'function') {
      problems.push('(a) activate() must have created the live OutputChannel');
    }
    const state0 = readState();
    if (!state0) {
      problems.push('(a) logger lifecycle state accessor is missing');
    } else {
      if (state0.armed !== true) problems.push('(a) activate() must arm logging via log.init()');
      if (state0.current !== true) problems.push('(a) a live channel must be cached after activation');
      if (state0.createCount < 1) problems.push('(a) at least one channel must have been created');
      if (state0.unarmedLogCount !== 0) {
        problems.push(`(a) ${state0.unarmedLogCount} activation log(s) fell back to console (03c O6)`);
      }
    }

    const p1 = Promise.resolve(mod.deactivate!());
    // 03c O2 / 03b OBJ-2 (review M2): the synchronous prefix of deactivate()
    // must NOT dispose — teardown has to settle first. p1 is not awaited yet
    // and dispose only runs in a .then() microtask, so `armed` is still true
    // here iff the latch was not flipped at entry. (An earlier version instead
    // required a zero `unarmedLogCount` delta across the whole settle window,
    // which a legitimate post-settlement warning would have false-redded.)
    const inFlightState = readState();
    if (!inFlightState || inFlightState.armed !== true) {
      problems.push('(b) deactivate() must dispose the channel after teardown, not at entry');
    }
    const p2 = Promise.resolve(mod.deactivate!());

    const outcome = await Promise.race([
      Promise.allSettled([p1, p2]),
      delay(DEACTIVATE_BUDGET_MS).then(() => 'timeout' as const),
    ]);
    assert.notStrictEqual(outcome, 'timeout', 'deactivate() must settle within 3s while an SSE client is open');
    for (const settled of outcome as PromiseSettledResult<unknown>[]) {
      assert.strictEqual(settled.status, 'fulfilled', 'deactivate() must never reject');
    }

    // ── (b) deactivate() disposed the live channel ───────────────────────
    if (liveLog._getChannelForTesting() !== undefined) {
      problems.push('(b) no live channel may remain cached after deactivate()');
    }
    const state1 = readState();
    if (state1 && state0) {
      if (state1.current !== false) problems.push('(b) state must report no current channel');
      if (state1.armed !== false) problems.push('(b) logging must be disarmed after deactivate()');
      if (state1.disposeCount !== state1.createCount) {
        problems.push('(b) every created channel must have been disposed');
      }
      if (state1.disposeFailureCount !== 0) {
        problems.push(`(b) ${state1.disposeFailureCount} channel dispose call(s) failed (03a OBJ-C2)`);
      }
      if (state1.disposeCount - state0.disposeCount !== 1) {
        problems.push('(b) the live channel must be disposed exactly once despite two deactivate() calls');
      }
    }
    // 03a OBJ-C3 / 03b OBJ-5 / 03c O3 (review M1): liveness probe, now
    // capability-gated. Only some VS Code builds throw synchronously from a
    // disposed wrapper's methods (observed on 1.130/1.141; the engine floor is
    // ^1.105.0, so a build without that guard is legitimate). Probe a throwaway
    // channel first; only when THIS build rejects writes to a disposed wrapper
    // must the live channel's wrapper be dead too. The counter deltas above are
    // the hard gate on every build.
    const capabilityChannel = vscode.window.createOutputChannel('xdebug-mcp disposal capability probe');
    // Let the host register the channel before disposing it; disposing in the
    // same tick warns about a disposable added to an already-disposed store
    // (seen on 1.141 — same reason as the re-arm cleanup below).
    await delay(250);
    capabilityChannel.dispose();
    let buildGuardsDisposedWrappers = false;
    try {
      capabilityChannel.appendLine('[test] capability probe');
    } catch {
      buildGuardsDisposedWrappers = true;
    }
    if (ch1 && buildGuardsDisposedWrappers) {
      let probeError: unknown;
      try {
        ch1.appendLine('[test] post-deactivate probe');
      } catch (error) {
        probeError = error;
      }
      // The class of the guard error is build-specific (round-2 minor), so ANY
      // throw is accepted here — the capability probe above already proved that
      // THIS build rejects writes to a disposed wrapper, and that probe's own
      // throw is the canonical error shape on this host.
      if (probeError === undefined) {
        problems.push('(b) the disposed channel wrapper must reject further writes');
      }
    }

    // ── (c) a late log must not re-create the channel ────────────────────
    liveLog.info('late log after deactivate');
    if (liveLog._getChannelForTesting() !== undefined) {
      problems.push('(c) a late log must not re-create or reuse a channel (the gap #3 defect)');
    }
    const state2 = readState();
    if (state2 && state1) {
      if (state2.createCount !== state1.createCount) problems.push('(c) a late log must not create a channel');
      if (state2.disposeCount !== state1.disposeCount) problems.push('(c) a late log must not dispose anything');
    }

    // ── (d) re-arm (what activate() does) must yield a fresh channel ─────
    liveLog.init('Xdebug MCP');
    const stateArmed = readState();
    if (stateArmed && stateArmed.armed !== true) problems.push('(d) init() must re-arm logging');
    liveLog.info('re-armed');
    const ch2 = liveLog._getChannelForTesting() as LiveChannel | undefined;
    if (!ch2) {
      problems.push('(d) a log after re-arm must create a fresh channel');
    } else if (ch2 === ch1) {
      problems.push('(d) the disposed channel must not be reused');
    }
    const state3 = readState();
    if (state3 && state2) {
      if (state3.createCount !== state2.createCount + 1) {
        problems.push('(d) re-arm must create exactly one new channel');
      }
      if (state3.current !== true) problems.push('(d) the fresh channel must be cached');
    }
    // Harness settle (reported deviation, see 07-test-report.md): VS Code
    // registers a new channel asynchronously; disposing it in the same JS tick
    // races the host's own registration/show continuations and makes it warn
    // "Trying to add a disposable to a DisposableStore that has already been
    // disposed" (observed on 1.141.2, un-delayed run). One settle window makes
    // the cleanup exercise the normal registered-channel disposal path. Every
    // assertion above is unaffected; production never re-arms within a tick.
    await delay(250);
    // Cleanup: a third deactivate() joins the (already settled) teardown and
    // disposes the fresh channel, leaving the module disarmed for steps 3-7.
    const p3 = Promise.resolve(mod.deactivate!());
    const outcome3 = await Promise.race([
      p3.then(() => 'resolved' as const, () => 'rejected' as const),
      delay(DEACTIVATE_BUDGET_MS).then(() => 'timeout' as const),
    ]);
    if (outcome3 !== 'resolved') {
      problems.push(`(d) cleanup deactivate() must settle and never reject (got ${outcome3})`);
    }
    if (liveLog._getChannelForTesting() !== undefined) {
      problems.push('(d) cleanup deactivate() must dispose the fresh channel');
    }

    assert.deepStrictEqual(problems, [],
      `output-channel disposal contract violations:\n- ${problems.join('\n- ')}`);

    // 3. The held connection must be SEVERED, not merely outlived.
    assert.ok(await pollUntil(() => sse!.closed(), SEVER_BUDGET_MS), 'held SSE connection must be closed by deactivate()');

    // 4. The discovery files must be gone.
    assert.ok(await pollUntil(() => !fs.existsSync(portFile), 2000), 'port file must be removed by deactivate()');
    assert.ok(await pollUntil(() => !fs.existsSync(perPidFile), 2000), 'per-instance discovery file must be removed by deactivate()');

    // 5. Invariant: nothing accepts new connections.
    assert.strictEqual(await tcpProbe(info.port), 'refused', 'no listener may accept connections after deactivate()');

    // 6. Teardown bookkeeping must be empty: no listener, sockets, closers or
    //    pending teardown retained (arbiter minors 3/4). The re-export is part
    //    of the change set (extension.ts); the precedent is
    //    `log._getChannelForTesting` in src/utils/logger.ts (line numbers in
    //    comments rot — same note as in extension.ts).
    assert.strictEqual(typeof mod._getTeardownStateForTesting, 'function', 'bundle must re-export _getTeardownStateForTesting');
    assert.deepStrictEqual(mod._getTeardownStateForTesting!(), {
      running: false,
      stopping: false,
      pendingStart: false,
      sockets: 0,
      closers: 0,
    });

    // 7. Invariant (does NOT prove connections were released): port rebindable.
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(info.port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
