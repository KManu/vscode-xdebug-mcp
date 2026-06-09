// src/test/suite/httpTransport.test.ts
// Integration tests for the HTTP MCP server transport.
// Makes real HTTP requests to the server running in the Extension Host.
import * as assert from 'assert';
import * as http from 'node:http';

// ── Port resolution helper ─────────────────────────────────────
// The MCP server writes its port to ~/.vscode-xdebug-mcp/port.json.
// Poll the file until it appears (server may not have started yet).

import { getServerPort, type PortInfo } from '../helpers/portResolver';

// ── HTTP request helper ────────────────────────────────────────

interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(options: {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: options.hostname,
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('HTTP Transport', function () {
  this.timeout(20000);

  let hostname: string;
  let port: number;

  before(async function () {
    const info = await getServerPort();
    hostname = info.host;
    port = info.port;
  });

  it('GET /health returns 200 with status, version, uptime', async function () {
    const res = await httpRequest({ hostname, port, path: '/health', method: 'GET' });

    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.version, 'string');
    assert.strictEqual(typeof body.uptime, 'number');
  });

  it('POST /mcp with JSON-RPC initialize request returns capabilities', async function () {
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0.0.0' },
      },
    });

    const res = await httpRequest({
      hostname,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initRequest,
    });

    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    const body = JSON.parse(res.body);
    assert.ok(body.result, 'initialize response should have result');
    assert.ok(body.result.capabilities, 'should include capabilities');
  });

  it('POST /mcp with JSON-RPC tools/list returns tool list', async function () {
    // First, send an initialized notification so the server is in initialized state.
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0.0.0' },
      },
    });

    await httpRequest({
      hostname,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initRequest,
    });

    // Send initialized notification.
    await httpRequest({
      hostname,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    // Now request tools.
    const toolsRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const res = await httpRequest({
      hostname,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: toolsRequest,
    });

    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    const body = JSON.parse(res.body);
    assert.ok(body.result, 'tools/list response should have result');
    assert.ok(Array.isArray(body.result.tools), 'should return tools array');
    assert.ok(body.result.tools.length > 0, 'should have at least one tool');
  });

  it('GET /mcp hangs (SSE negotiation endpoint — request stays open)', async function () {
    // The MCP StreamableHTTP transport handles GET /mcp as an SSE negotiation
    // endpoint and keeps the connection open indefinitely.
    // We verify this by setting a short socket timeout and asserting the request
    // is killed by the timeout (not a normal HTTP response).
    const result = await new Promise<'timeout' | 'response'>((resolve) => {
      const req = http.request(
        { hostname, port, path: '/mcp', method: 'GET' },
        (res) => {
          // If we somehow get a response, consume it.
          res.resume();
          res.on('end', () => resolve('response'));
        },
      );
      req.on('error', () => resolve('timeout'));
      req.setTimeout(2000, () => {
        req.destroy(new Error('timeout'));
        resolve('timeout');
      });
      req.end();
    });

    assert.strictEqual(result, 'timeout', 'GET /mcp should hang (SSE) causing socket timeout, not return a normal HTTP response');
  });

  it('GET /nonexistent returns 404', async function () {
    const res = await httpRequest({ hostname, port, path: '/nonexistent', method: 'GET' });

    assert.strictEqual(res.statusCode, 404, `Expected 404, got ${res.statusCode}`);
  });

  it('request body > 2MB returns 413 with JSON-RPC error', async function () {
    // Create a body larger than 2MB.
    const largeBody = Buffer.alloc(2.1 * 1024 * 1024, 'x').toString('utf8');
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 999,
      method: 'tools/list',
      params: { junk: largeBody },
    });

    try {
      const res = await httpRequest({
        hostname,
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: payload,
      });

      assert.strictEqual(res.statusCode, 413, `Expected 413, got ${res.statusCode}`);

      const body = JSON.parse(res.body);
      assert.ok(body.error, 'Should include JSON-RPC error');
      assert.strictEqual(body.error.code, -32700);
      assert.strictEqual(body.error.message, 'Payload too large');
    } catch (err) {
      // Write errors may occur if the connection is destroyed by the server.
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        message.includes('ECONNRESET') || message.includes('socket hang up') || message.includes('EPIPE'),
        `Expected connection error for rejected payload, got: ${message}`
      );
    }
  });

  it('malformed JSON returns 400 with JSON-RPC error', async function () {
    const res = await httpRequest({
      hostname,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: 'this is not json { broken',
    });

    assert.strictEqual(res.statusCode, 400, `Expected 400, got ${res.statusCode}`);

    const body = JSON.parse(res.body);
    assert.ok(body.error, 'Should include JSON-RPC error');
    assert.strictEqual(body.error.code, -32700);
  });

  it('empty POST body returns 400 with JSON-RPC error', async function () {
    try {
      const res = await httpRequest({
        hostname,
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '',
      });

      assert.strictEqual(res.statusCode, 400, `Expected 400, got ${res.statusCode}`);

      const body = JSON.parse(res.body);
      assert.ok(body.error, 'Should include JSON-RPC error');
      assert.strictEqual(body.error.code, -32700);
    } catch (err) {
      // The server may reject the connection for empty body.
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(
        message.includes('ECONNRESET') || message.includes('Parse error') || message.includes('socket hang up'),
        `Expected rejection for empty body, got: ${message}`
      );
    }
  });
});
