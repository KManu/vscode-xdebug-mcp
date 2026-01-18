import express, { type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeServer } from './server';

const HOST = '127.0.0.1';
const PORT = 3098;

let runningServer: HttpServer | undefined;
let serverUriPromise: Promise<string> | undefined;

export async function startHttpServer(): Promise<string> {
  if (serverUriPromise) {
    return serverUriPromise;
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.all('/mcp', async (req: Request, res: Response) => {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    const accept = req.headers.accept;
    if (req.method === 'POST') {
      if (!accept || !accept.includes('application/json') || !accept.includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
      }
      const contentType = req.headers['content-type'];
      if (!contentType && req.body !== undefined) {
        req.headers['content-type'] = 'application/json';
      }
    } else if (req.method === 'GET') {
      if (!accept || !accept.includes('text/event-stream')) {
        req.headers.accept = 'text/event-stream';
      }
    }

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

    res.on('close', handleClose);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    } finally {
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
    const httpServer = app.listen(PORT, HOST, () => {
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

  runningServer = undefined;
  serverUriPromise = undefined;
}
