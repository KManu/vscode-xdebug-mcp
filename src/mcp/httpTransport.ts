import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeServer } from './server';
import { log } from '../utils/logger';
import { writePortFile, writeStoppedFile, cleanupPortFile } from '../utils/portFile';

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

export async function startHttpServer(options: { version?: string } = {}): Promise<string> {
  // Prevent multiple simultaneous server starts on extension reloads.
  if (serverUriPromise) {
    return serverUriPromise;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enforce a request timeout so slow clients cannot block the event loop.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        res.statusCode = 408;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Request timeout' },
          id: null
        }));
      }
      req.destroy();
    });

    // Health check endpoint for monitoring and diagnostics.
    const url = new URL(req.url ?? '/', `http://${HOST}:${DEFAULT_PORT}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: 'ok',
        version: options.version,
        uptime: process.uptime()
      }));
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
      enableJsonResponse: true
    });

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

        req.on('data', chunk => {
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

    let closed = false;
    const closeTransport = async () => {
      if (closed) {
        return;
      }
      closed = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    const handleClose = () => {
      void closeTransport();
    };

    // Clean up when the client disconnects (important for streaming responses).
    res.on('close', handleClose);

    let parsedBody: unknown | undefined;
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
                data: message
              },
              id: null
            })
          );
        }
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
      // Avoid leaking listeners in case of streaming responses.
      if (typeof res.off === 'function') {
        res.off('close', handleClose);
      } else {
        res.removeListener('close', handleClose);
      }
      // Let the response lifecycle determine when to close the transport.
      // Closing here can end the response before the server sends JSON-RPC output.
    }
  });

  // Detect unexpected server death and reset state so future starts can recover.
  httpServer.on('close', () => {
    if (runningServer === httpServer) {
      log.info('HTTP server closed unexpectedly');
      runningServer = undefined;
      serverUriPromise = undefined;
    }
  });

  serverUriPromise = new Promise<string>((resolve, reject) => {
    // Try default port first; fall back to port 0 (OS-assigned) on EADDRINUSE.
    const tryListen = (port: number) => {
      httpServer.listen(port, HOST, () => {
        const actualPort = (httpServer.address() as { port: number }).port;
        const uri = `http://${HOST}:${actualPort}/mcp`;
        lastKnownUri = uri;

        // Write the port file for external clients to discover the server.
        writePortFile({
          uri,
          host: HOST,
          port: actualPort,
          version: options.version ?? '0.0.1',
          pid: process.pid,
          started: new Date().toISOString(),
        });

        resolve(uri);
      });
    };

    let portAttempts = 0;

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && portAttempts < MAX_PORT_ATTEMPTS) {
        portAttempts++;
        if (portAttempts >= MAX_PORT_ATTEMPTS) {
          serverUriPromise = undefined;
          runningServer = undefined;
          reject(new Error(`Failed to bind MCP server after ${MAX_PORT_ATTEMPTS} attempts. Port ${DEFAULT_PORT} and dynamic ports are all occupied.`));
          return;
        }
        const fallbackPort = portAttempts === 1 ? 0 : undefined;
        log.info(`Port ${DEFAULT_PORT} in use, falling back to dynamic port (attempt ${portAttempts}/${MAX_PORT_ATTEMPTS - 1})`);
        tryListen(fallbackPort ?? 0);
      } else {
        serverUriPromise = undefined;
        runningServer = undefined;
        reject(err);
      }
    });

    tryListen(DEFAULT_PORT);
    runningServer = httpServer;
  });

  return serverUriPromise;
}

export function getLastKnownUri(): string | undefined {
  return lastKnownUri;
}

export async function stopHttpServer(): Promise<void> {
  if (!runningServer) {
    return;
  }

  // Mark port file as stopped before closing so readers see the stopped state.
  writeStoppedFile();

  const server = runningServer;
  // Reset state BEFORE closing to avoid the close handler logging 'closed unexpectedly'.
  runningServer = undefined;
  serverUriPromise = undefined;
  lastKnownUri = undefined;

  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  // Clean up port file after server is fully stopped.
  cleanupPortFile();
}
