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

interface LiveExtensionModule {
  deactivate?: () => unknown;
  _getTeardownStateForTesting?: () => Record<string, unknown>;
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
    const p1 = Promise.resolve(mod.deactivate!());
    const p2 = Promise.resolve(mod.deactivate!());

    const outcome = await Promise.race([
      Promise.allSettled([p1, p2]),
      delay(DEACTIVATE_BUDGET_MS).then(() => 'timeout' as const),
    ]);
    assert.notStrictEqual(outcome, 'timeout', 'deactivate() must settle within 3s while an SSE client is open');
    for (const settled of outcome as PromiseSettledResult<unknown>[]) {
      assert.strictEqual(settled.status, 'fulfilled', 'deactivate() must never reject');
    }

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
    //    src/utils/logger.ts:65 (_getChannelForTesting).
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
