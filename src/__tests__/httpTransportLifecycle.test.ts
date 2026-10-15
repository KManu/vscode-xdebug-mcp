// src/__tests__/httpTransportLifecycle.test.ts
// Fast regression suite for the deterministic port/server/port-file teardown.
// Uses the REAL SDK and the REAL src/mcp/httpTransport.ts (no mocks). The port
// dir is isolated per-fork by src/__tests__/setup.ts via XDEBUG_MCP_PORT_DIR.
import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import {
  startHttpServer,
  stopHttpServer,
  MCP_START_SUPERSEDED_MESSAGE,
  _getTeardownStateForTesting,
} from '../mcp/httpTransport';
import { readPortFile } from '../utils/portFile';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function settle<T>(promise: Promise<T>, ms: number): Promise<'resolved' | 'rejected' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve('resolved');
      },
      () => {
        clearTimeout(timer);
        resolve('rejected');
      }
    );
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function port(uri: string): number {
  return Number(new URL(uri).port);
}

interface TrackedClient {
  destroy: () => void;
}

// Every held connection is destroyed in afterEach before the stop, so a leaked
// stream can never stall the suite teardown.
const tracked: TrackedClient[] = [];

interface HeldSse {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  closed: () => boolean;
}

function holdSse(port: number): Promise<HeldSse> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/mcp', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET /mcp expected 200, got ${res.statusCode}`));
          return;
        }
        let closed = false;
        res.on('close', () => {
          closed = true;
        });
        res.on('end', () => {
          closed = true;
        });
        res.on('data', () => {});
        res.on('error', () => {});
        const held: HeldSse = { req, res, closed: () => closed };
        tracked.push({ destroy: () => req.destroy() });
        resolve(held);
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('test client timeout')));
  });
}

function halfOpenPost(port: number): Promise<{ socket: net.Socket; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      connected = true;
      // Send full headers declaring a body that never arrives, then keep the
      // socket open: the server's readJsonBody() waits for 'end' forever.
      socket.write(
        'POST /mcp HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n' +
          'Accept: application/json, text/event-stream\r\n' +
          '\r\n'
      );
      let closed = false;
      socket.on('close', () => {
        closed = true;
      });
      tracked.push({ destroy: () => socket.destroy() });
      resolve({ socket, closed: () => closed });
    });
    socket.on('error', (err) => {
      if (!connected) reject(err);
    });
  });
}

function postJson(
  uri: string,
  agent: http.Agent,
  body: unknown
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(uri);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let bodyStr = '';
        res.on('data', (chunk: Buffer) => {
          bodyStr += chunk.toString();
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: bodyStr }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const ALL_ZERO = {
  running: false,
  stopping: false,
  pendingStart: false,
  sockets: 0,
  closers: 0,
};

afterEach(async () => {
  for (const client of tracked) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
  }
  tracked.length = 0;
  await settle(stopHttpServer(), 3000);
});

describe('httpTransport teardown lifecycle (real SDK)', () => {
  it('scenario 1: held SSE + synchronous release prefix', async () => {
    const uri = await startHttpServer();
    const held = await holdSse(port(uri));
    await delay(100);
    expect(held.res.complete).toBe(false);

    // The discovery file must be gone SYNCHRONOUSLY, before any await.
    const stop = stopHttpServer();
    expect(readPortFile()).toBeNull();

    expect(await settle(stop, 3000)).toBe('resolved');
    expect(await waitFor(() => held.closed(), 1000)).toBe(true);
  });

  it('scenario 2: half-open POST (body headers, no body) does not block stop', async () => {
    const uri = await startHttpServer();
    const halfOpen = await halfOpenPost(port(uri));
    await delay(150);

    const stop = stopHttpServer();
    expect(await settle(stop, 3000)).toBe('resolved');
    expect(await waitFor(() => halfOpen.closed(), 1000)).toBe(true);
    expect(readPortFile()).toBeNull();
  });

  it('scenario 3: idle keep-alive socket is closed on stop', async () => {
    const uri = await startHttpServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    tracked.push({ destroy: () => agent.destroy() });

    const res = await postJson(uri, agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lifecycle-test', version: '0.0.0' },
      },
    });
    expect(res.statusCode).toBe(200);

    const stop = stopHttpServer();
    expect(await settle(stop, 3000)).toBe('resolved');
    expect(readPortFile()).toBeNull();
  });

  it('scenario 4: 10-cycle restart/double-stop/no-op storm with registry bounds', async () => {
    for (let i = 0; i < 10; i++) {
      const uri = await startHttpServer();

      // Restart writes a live entry whose URI equals the returned URI.
      const live = readPortFile();
      expect(live).not.toBeNull();
      expect(live && !('status' in live)).toBe(true);
      if (live && !('status' in live)) {
        expect(live.uri).toBe(uri);
      }

      const p1 = stopHttpServer();
      const p2 = stopHttpServer();
      expect(await settle(p1, 3000)).toBe('resolved');
      expect(await settle(p2, 3000)).toBe('resolved');
      expect(readPortFile()).toBeNull();
      expect(_getTeardownStateForTesting()).toEqual(ALL_ZERO);
    }

    // Final no-op stop resolves promptly.
    expect(await settle(stopHttpServer(), 1000)).toBe('resolved');
  });

  it('scenario 5: start-during-stop + late-continuation protection', async () => {
    const uriA = await startHttpServer();
    const heldA = await holdSse(port(uriA));
    await delay(100);

    const stopA = stopHttpServer(); // sync prefix releases A's file immediately
    const startB = startHttpServer(); // waits for A's teardown, then starts
    // Destroy A's client while A's teardown is in flight. The late 'close'
    // continuation must NOT delete B's discovery file.
    heldA.req.destroy();

    const uriB = await startB;
    await delay(50);

    const live = readPortFile();
    expect(live).not.toBeNull();
    expect(live && !('status' in live)).toBe(true);
    if (live && !('status' in live)) {
      expect(live.uri).toBe(uriB);
    }
    expect(_getTeardownStateForTesting().running).toBe(true);

    await settle(stopHttpServer(), 3000);
  });

  it('scenario 5b: provider-equivalent post-await re-stop leaves nothing running', async () => {
    const uri = await startHttpServer();
    const held = await holdSse(port(uri));
    await delay(100);
    expect(held.res.complete).toBe(false);

    // Mirror the provider's deactivated branch (§4.3): after the start has
    // resolved, a re-stop is the closing guard.
    const stop = stopHttpServer();
    expect(readPortFile()).toBeNull();
    expect(await settle(stop, 3000)).toBe('resolved');
    expect(await waitFor(() => held.closed(), 1000)).toBe(true);
    expect(_getTeardownStateForTesting()).toEqual(ALL_ZERO);
  });

  it('scenario 6: stop during in-flight listen rejects the start and restart works', async () => {
    // Calling stopHttpServer() in the same synchronous tick as startHttpServer()
    // cancels the in-flight bind (net.Server.close() never fires the listen
    // callback in that case) — the start must reject, not hang forever.
    const start = startHttpServer();
    const stop = stopHttpServer();

    expect(await settle(start, 3000)).toBe('rejected');
    let startReason: unknown;
    await start.catch((error: unknown) => {
      startReason = error;
    });
    expect((startReason as Error).message).toBe(MCP_START_SUPERSEDED_MESSAGE);

    expect(await settle(stop, 3000)).toBe('resolved');
    expect(readPortFile()).toBeNull();

    // Restart works after the superseded start.
    const uri2 = await startHttpServer();
    const live = readPortFile();
    expect(live).not.toBeNull();
    expect(live && !('status' in live)).toBe(true);
    if (live && !('status' in live)) {
      expect(live.uri).toBe(uri2);
    }
    await settle(stopHttpServer(), 3000);
  });

  it('scenario 7: SDK pin for the parsed in-flight POST (OBJ-F1)', async () => {
    const mcp = new McpServer({ name: 'pin', version: '0.0.1' });
    mcp.registerTool(
      'never',
      { description: 'never resolves' },
      () => new Promise<never>(() => {})
    );

    let transport: StreamableHTTPServerTransport | undefined;
    const httpServer = http.createServer(async (req, res) => {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'never', arguments: {} },
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const pinPort = (httpServer.address() as net.AddressInfo).port;

    const outcome = await new Promise<{
      status?: number;
      body?: string;
      error?: string;
      aborted?: boolean;
    }>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: pinPort,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
          res.on('aborted', () => resolve({ aborted: true }));
          res.on('error', (error) => resolve({ error: error.message }));
        }
      );
      req.on('error', (error) => resolve({ error: error.message }));
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: { name: 'never', arguments: {} },
        })
      );

      // Run the plan's canonical teardown after the request is parsed in-flight.
      setTimeout(async () => {
        try {
          await transport?.close();
        } catch {
          /* ignore */
        }
        httpServer.close(() => {});
        (httpServer as http.Server & { closeIdleConnections?: () => void }).closeIdleConnections?.();
        (httpServer as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }, 100);
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body).toBe('');
  });
});
