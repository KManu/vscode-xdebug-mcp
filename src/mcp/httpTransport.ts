import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeServer } from './server';

// We bind locally so only the current machine can reach the MCP server.
const HOST = '127.0.0.1';
const PORT = 3098;
// Guard against large JSON-RPC payloads from accidental dumps.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

let runningServer: HttpServer | undefined;
let serverUriPromise: Promise<string> | undefined;

export async function startHttpServer(options: { version?: string } = {}): Promise<string> {
  // Prevent multiple simultaneous server starts on extension reloads.
  if (serverUriPromise) {
    return serverUriPromise;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only a single MCP endpoint is exposed; keep the surface area tight.
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
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

  serverUriPromise = new Promise<string>((resolve, reject) => {
    // Start listening once; resolves with the MCP endpoint URL.
    httpServer.listen(PORT, HOST, () => {
      resolve(`http://${HOST}:${PORT}/mcp`);
    });

    httpServer.once('error', (err: Error) => {
      serverUriPromise = undefined;
      reject(err);
    });

    runningServer = httpServer;
  });

  return serverUriPromise;
}

export async function stopHttpServer(): Promise<void> {
  if (!runningServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    runningServer?.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  // Reset cached state so a future activate can restart cleanly.
  runningServer = undefined;
  serverUriPromise = undefined;
}
