import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeServer } from './server';
import { log } from '../utils/logger';
import { writePortFile, releaseOwnedPortFile } from '../utils/portFile';

// We bind locally so only the current machine can reach the MCP server.
const HOST = '127.0.0.1';
const DEFAULT_PORT = 3098;
// Guard against large JSON-RPC payloads from accidental dumps.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Request timeout to prevent slow clients from blocking the event loop.
const REQUEST_TIMEOUT_MS = 30_000;
// Prevent infinite port-binding retries when all ports are occupied.
const MAX_PORT_ATTEMPTS = 3;

let runningServer: HttpServer | undefined;
let serverUriPromise: Promise<string> | undefined;
let lastKnownUri: string | undefined;

// Message identity for a start cancelled by a stop. The provider/activate
// callers use this constant instead of matching the string literal.
export const MCP_START_SUPERSEDED_MESSAGE = 'MCP server start superseded by stop';

// Monotonic token: bumped by every stop that actually releases a server and by
// every start. Async continuations verify they are still current.
let generation = 0;

// Reject handle for the one start that may be unsettled. net.Server.close()
// during an in-flight listen cancels the bind WITHOUT firing the listen
// callback and without emitting 'error' (probe: close cb ERR_SERVER_NOT_RUNNING).
let pendingStart: { generation: number; reject: (error: Error) => void } | undefined;

// Joins concurrent/repeat stops: deactivate() and the subscription disposable
// both call stopHttpServer(); the second caller awaits the same teardown.
let stoppingPromise: Promise<void> | undefined;

// Per-request closers (MCP server + transport). stopHttpServer() invokes them
// so SSE streams end with res.end() before sockets are destroyed.
const activeRequestClosers = new Set<() => Promise<void>>();

// Accepted sockets: fallback destroy path (Node < 18.2, @types/node/http.d.ts:482).
const activeSockets = new Set<Socket>();

/** Release the discovery file from event handlers without risking a throw. */
function releasePortFileSafely(uri: string): void {
  try {
    releaseOwnedPortFile(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[xdebug-mcp] port file release failed: ${message}`);
  }
}

// Extract the JSON-RPC request id for the 408 timeout response: string ids are
// valid JSON-RPC (they are typically not used by MCP clients, but the server
// must echo whatever the client sent), and notifications carry no id.
export function extractJsonRpcId(body: unknown): number | string | null {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === 'number' || typeof id === 'string') {
      return id;
    }
  }
  return null;
}

// Build the 408 JSON-RPC error response. Echoing the original request id keeps
// the response well-formed (previously id: null even when the client sent one).
export function handleRequestTimeout(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
): void {
  if (!res.headersSent) {
    res.statusCode = 408;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request timeout' },
        id: extractJsonRpcId(parsedBody),
      })
    );
  }
  req.destroy();
}

export function startHttpServer(options: { version?: string } = {}): Promise<string> {
  // Single-flight: the promise is assigned synchronously, so concurrent callers
  // (activate + the MCP provider) share exactly one server.
  if (serverUriPromise) {
    return serverUriPromise;
  }
  const myGeneration = ++generation;
  const attempt = startHttpServerInternal(options, myGeneration);
  serverUriPromise = attempt;
  // A failed/superseded start must not poison the module. Identity check
  // avoids clobbering a newer start.
  void attempt.catch(() => {
    if (serverUriPromise === attempt) {
      serverUriPromise = undefined;
    }
  });
  return attempt;
}

async function startHttpServerInternal(
  options: { version?: string },
  myGeneration: number
): Promise<string> {
  // Serialize restart-after-stop: never create a second listener while a
  // previous teardown is still in flight.
  if (stoppingPromise) {
    await stoppingPromise;
  }
  if (myGeneration !== generation) {
    throw new Error(MCP_START_SUPERSEDED_MESSAGE);
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Parsed body, in scope for the timeout handler below (declared before it
    // is registered so the 408 can echo the original request id).
    let parsedBody: unknown | undefined;

    // Enforce a request timeout so slow clients cannot block the event loop.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => handleRequestTimeout(req, res, parsedBody));

    // Health check endpoint for monitoring and diagnostics.
    const url = new URL(req.url ?? '/', `http://${HOST}:${DEFAULT_PORT}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          version: options.version,
          uptime: process.uptime(),
        })
      );
      return;
    }

    // Only a single MCP endpoint is exposed; keep the surface area tight.
    if (url.pathname !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }

    // Create a new MCP server for each request. The transport manages lifecycle.
    const server = makeServer({ version: options.version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let closed = false;
    const closeTransport = async () => {
      if (closed) {
        return;
      }
      closed = true;
      activeRequestClosers.delete(closeTransport);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    activeRequestClosers.add(closeTransport);

    // Normalize headers so the MCP SDK sees the expected Accept/Content-Type.
    const accept = req.headers.accept;
    if (req.method === 'POST') {
      if (!accept || !accept.includes('application/json') || !accept.includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
      }
      const contentType = req.headers['content-type'];
      if (!contentType) {
        req.headers['content-type'] = 'application/json';
      }
    } else if (req.method === 'GET') {
      if (!accept || !accept.includes('text/event-stream')) {
        req.headers.accept = 'text/event-stream';
      }
    }

    // Manually parse JSON to enforce a hard size limit before buffering.
    const readJsonBody = async (): Promise<unknown> =>
      await new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];

        req.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_BODY_BYTES) {
            const error = new Error('Payload too large');
            (error as Error & { code?: string }).code = 'PAYLOAD_TOO_LARGE';
            reject(error);
            req.destroy();
            return;
          }
          chunks.push(buffer);
        });

        req.on('end', () => {
          if (chunks.length === 0) {
            reject(new Error('Empty request body'));
            return;
          }
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });

        req.on('error', reject);
      });

    const handleClose = () => {
      void closeTransport();
    };

    // Clean up when the client disconnects (important for streaming responses).
    res.on('close', handleClose);

    if (req.method === 'POST') {
      try {
        parsedBody = await readJsonBody();
      } catch (error) {
        // Return a JSON-RPC shaped error when parsing fails.
        if (!res.headersSent) {
          const message = error instanceof Error ? error.message : String(error);
          const status = (error as Error & { code?: string }).code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32700,
                message: status === 413 ? 'Payload too large' : 'Parse error',
                data: message,
              },
              id: null,
            })
          );
        }
        // Release the per-request server + transport now; the retained 'close'
        // listener would also do it, but this keeps cleanup deterministic.
        void closeTransport();
        return;
      }
    }

    try {
      // Connect the MCP server to the HTTP transport, then handle the request.
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: message }));
      }
    } finally {
      if (res.writableEnded) {
        // The response ended synchronously inside handleRequest (SDK error
        // responses). Normal JSON-RPC responses with enableJsonResponse are
        // written later by the SDK's send() (streamableHttp.js:609-611), so
        // right after handleRequest() resolves writableEnded === false; their
        // cleanup goes through the retained 'close' listener below.
        void closeTransport();
      }
      // For a streaming (SSE) response, handleRequest() returns while the
      // response is open. Keep handleClose attached: it fires when the client
      // disconnects OR when stopHttpServer() ends the stream via
      // closeTransport() (transport.close() → res.end()).
    }
  });

  httpServer.on('connection', (socket: Socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  httpServer.on('close', () => {
    if (runningServer === httpServer) {
      log.info('HTTP server closed unexpectedly');
      runningServer = undefined;
      serverUriPromise = undefined;
      const ownedUri = lastKnownUri;
      lastKnownUri = undefined;
      if (ownedUri !== undefined) {
        releasePortFileSafely(ownedUri);
      }
    }
  });

  return new Promise<string>((resolve, reject) => {
    const settleResolve = (uri: string) => {
      if (pendingStart?.generation === myGeneration) {
        pendingStart = undefined;
      }
      resolve(uri);
    };
    const settleReject = (error: Error) => {
      if (pendingStart?.generation === myGeneration) {
        pendingStart = undefined;
      }
      reject(error);
    };
    // Invariant (relied on by stopHttpServer's no-server branch): pendingStart
    // and runningServer are assigned in the same synchronous prologue, so there
    // is no interleaving where pendingStart is set but runningServer is not.
    // Every path that clears runningServer also clears/rejects pendingStart
    // (identity-checked settleReject; stopHttpServer's sync prefix clears both).
    pendingStart = { generation: myGeneration, reject: settleReject };

    // Try default port first; fall back to an OS-assigned port on EADDRINUSE.
    const tryListen = (port: number) => {
      httpServer.listen(port, HOST, () => {
        if (myGeneration !== generation) {
          // A stop landed while the bind was in flight. close() unbinds; the
          // close callback swallows ERR_SERVER_NOT_RUNNING.
          httpServer.close(() => undefined);
          settleReject(new Error(MCP_START_SUPERSEDED_MESSAGE));
          return;
        }
        const actualPort = (httpServer.address() as { port: number }).port;
        const uri = `http://${HOST}:${actualPort}/mcp`;
        lastKnownUri = uri;

        writePortFile({
          uri,
          host: HOST,
          port: actualPort,
          version: options.version ?? '0.0.1',
          pid: process.pid,
          started: new Date().toISOString(),
        });

        settleResolve(uri);
      });
    };

    let portAttempts = 0;

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (myGeneration !== generation) {
        settleReject(new Error(MCP_START_SUPERSEDED_MESSAGE));
        return;
      }
      if (err.code === 'EADDRINUSE' && portAttempts < MAX_PORT_ATTEMPTS) {
        portAttempts++;
        if (portAttempts >= MAX_PORT_ATTEMPTS) {
          runningServer = undefined;
          lastKnownUri = undefined;
          settleReject(
            new Error(
              `Failed to bind MCP server after ${MAX_PORT_ATTEMPTS} attempts. Port ${DEFAULT_PORT} and dynamic ports are all occupied.`
            )
          );
          return;
        }
        const fallbackPort = portAttempts === 1 ? 0 : undefined;
        log.info(
          `Port ${DEFAULT_PORT} in use, falling back to dynamic port (attempt ${portAttempts}/${MAX_PORT_ATTEMPTS - 1})`
        );
        tryListen(fallbackPort ?? 0);
      } else {
        // Non-retryable error: never leave a bound listener or a discovery
        // entry orphaned.
        if (httpServer.listening) {
          httpServer.close(() => undefined);
        }
        if (runningServer === httpServer) {
          runningServer = undefined;
          // H1 FIX: this attempt may already have FULFILLED in the listen
          // callback (post-listen error), so the wrapper's identity-checked
          // catch will never run for it. Without this line every later
          // startHttpServer() returns this dead URI forever (regression vs.
          // the current code at src/mcp/httpTransport.ts:267).
          serverUriPromise = undefined;
          const ownedUri = lastKnownUri;
          lastKnownUri = undefined;
          if (ownedUri !== undefined) {
            releasePortFileSafely(ownedUri);
          }
        }
        settleReject(err);
      }
    });

    tryListen(DEFAULT_PORT);
    runningServer = httpServer;
  });
}

export function getLastKnownUri(): string | undefined {
  return lastKnownUri;
}

const STOP_GRACE_MS = 250;
const STOP_CONFIRM_MS = 1500;

/** Resolve with the promise's value, or 'timeout' — never rejects, never leaks a live timer. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve('timeout');
      }
    );
  });
}

export function stopHttpServer(): Promise<void> {
  const server = runningServer;

  if (!server) {
    // H2 FIX: nothing this instance can release. Join an in-flight teardown
    // (the normal deactivate() + subscriptions-dispose sequence shares one
    // promise) but do NOT supersede a start that is waiting on that teardown:
    // a join is not a new stop decision. pendingStart implies runningServer
    // was set in the same synchronous prologue, so no pending start can exist
    // here (see the invariant comment in startHttpServerInternal).
    return stoppingPromise ?? Promise.resolve();
  }

  // Supersede any in-flight start: close() during an in-flight listen cancels
  // the bind without firing the listen callback or 'error' (probe), so settle
  // the pending start explicitly.
  generation++;
  if (pendingStart) {
    const superseded = pendingStart;
    pendingStart = undefined;
    superseded.reject(new Error(MCP_START_SUPERSEDED_MESSAGE));
  }

  // ── Synchronous release prefix (must never sit behind an await) ──────────
  const ownedUri = lastKnownUri;
  runningServer = undefined;
  serverUriPromise = undefined;
  lastKnownUri = undefined;
  if (ownedUri !== undefined) {
    // OBJ-F4: never let a throw from logging/fs escape — releaseServer() below
    // must run unconditionally and stopHttpServer() must never reject.
    try {
      const outcome = releaseOwnedPortFile(ownedUri);
      log.info(`MCP server stopped; port file: ${outcome} (uri=${ownedUri})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[xdebug-mcp] port file release failed during stop: ${message}`);
    }
  }

  const teardown = releaseServer(server).finally(() => {
    if (stoppingPromise === teardown) {
      stoppingPromise = undefined;
    }
  });
  stoppingPromise = teardown;
  return teardown;
}

async function releaseServer(server: HttpServer): Promise<void> {
  try {
    // 1. Unbind and stop accepting. net.Server.close() releases the listening
    //    socket synchronously; the callback only reports when connections end
    //    (net.d.ts:618-628). ERR_SERVER_NOT_RUNNING is expected when the
    //    listen had not completed (probe) and must not fail.
    const closed = new Promise<void>((resolve) => {
      try {
        server.close((err?: Error) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            log.warn(`HTTP server close reported: ${err.message}`);
          }
          resolve();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`HTTP server close threw: ${message}`);
        resolve();
      }
    });

    // 2. End SSE streams gracefully and close per-request MCP servers.
    //    transport.close() calls res.end() on every standalone SSE stream
    //    (streamableHttp.js:532-537) and on parsed in-flight POST responses
    //    (registered in _streamMapping at :403, before the handler at :418),
    //    which reach the client as an EMPTY HTTP 200 (probe 06, 6/6). Bounded
    //    so a misbehaving transport cannot delay teardown.
    const closers = [...activeRequestClosers];
    activeRequestClosers.clear();
    if (closers.length > 0) {
      await settleWithin(
        Promise.allSettled(closers.map((close) => Promise.resolve().then(close))),
        STOP_GRACE_MS
      );
    }

    // 3. Drop idle keep-alive sockets, then force-close everything left.
    //    Order matters: close() first (unbind), then destroy connections
    //    (closeAllConnections() alone does not unbind).
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    } else {
      for (const socket of activeSockets) {
        socket.destroy();
      }
    }

    // 4. Confirm closure, but never block past the budget.
    if ((await settleWithin(closed, STOP_CONFIRM_MS)) === 'timeout') {
      log.warn('HTTP server close was not confirmed within the teardown budget; the listener was already released');
    }
  } catch (error) {
    // stopHttpServer() must never reject: the subscription disposable is
    // fire-and-forget, so a rejection here would be an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Server teardown error (ignored): ${message}`);
  } finally {
    activeSockets.clear();
  }
}

/** Test-only read-only view of teardown bookkeeping (precedent: logger._getChannelForTesting). */
export function _getTeardownStateForTesting(): {
  running: boolean;
  stopping: boolean;
  pendingStart: boolean;
  sockets: number;
  closers: number;
} {
  return {
    running: runningServer !== undefined,
    stopping: stoppingPromise !== undefined,
    pendingStart: pendingStart !== undefined,
    sockets: activeSockets.size,
    closers: activeRequestClosers.size,
  };
}
