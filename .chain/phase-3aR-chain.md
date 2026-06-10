# Phase 3aR — Fix httpTransport Tests to Use Real HTTP

## Context
The current httpTransport.test.ts re-implements httpTransport.ts logic in test helpers instead of testing the real module. This must be replaced with tests that make real HTTP requests against the actual server.

## Goal
Rewrite httpTransport.test.ts to use the REAL startHttpServer() and make real HTTP requests using Node's native http module.

## Files to Modify
- `src/__tests__/httpTransport.test.ts` — complete rewrite

## Implementation Steps

### 1. Remove all mocking of node:http
DELETE the current mock:
```typescript
// REMOVE THIS:
vi.mock('node:http', () => ({
  createServer: vi.fn(),
}));
```
The real node:http module will be used.

### 2. Keep other mocks
KEEP mocks for:
- `../mcp/server` — mock makeServer (we're testing transport, not the MCP server)
- `@modelcontextprotocol/sdk/server/streamableHttp.js` — mock StreamableHTTPServerTransport

### 3. Import the real http module
```typescript
import * as http from 'node:http';
import { startHttpServer, stopHttpServer } from '../httpTransport';
```

### 4. Server lifecycle in beforeEach/afterEach
```typescript
let serverUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  serverUrl = await startHttpServer();
});

afterEach(async () => {
  await stopHttpServer();
});
```

### 5. Helper to make POST requests with body
```typescript
function makePostRequest(body: string | null): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve) => {
    const url = new URL(serverUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', (err) => fail(err.message));
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}
```

### 6. Helper for GET requests
```typescript
function makeGetRequest(): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const url = new URL(serverUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.end();
  });
}
```

### 7. Test cases

#### Body size tests
```typescript
it('should return 413 for body > 2MB', async () => {
  const body = JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) });
  const res = await makePostRequest(body);
  expect(res.statusCode).toBe(413);
  const json = JSON.parse(res.body);
  expect(json.jsonrpc).toBe('2.0');
  expect(json.error.message).toBe('Payload too large');
});

it('should accept body at exactly 2MB', async () => {
  const twoMB = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024 - 20) });
  const res = await makePostRequest(twoMB);
  // Should not be 413 — passes through to MCP handler or returns different error
  expect(res.statusCode).not.toBe(413);
});

it('should return 400 for empty body', async () => {
  const res = await makePostRequest(null);
  expect(res.statusCode).toBe(400);
  const json = JSON.parse(res.body);
  expect(json.jsonrpc).toBe('2.0');
  expect(json.error.code).toBe(-32700);
});

it('should return 400 for malformed JSON', async () => {
  const res = await makePostRequest('{ not valid json }');
  expect(res.statusCode).toBe(400);
  const json = JSON.parse(res.body);
  expect(json.jsonrpc).toBe('2.0');
  expect(json.error.code).toBe(-32700);
});
```

#### Path routing test
```typescript
it('should return 404 for non-/mcp paths', async () => {
  const url = new URL(serverUrl);
  const res = await new Promise<http.IncomingMessage>((resolve) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/other',
      method: 'GET',
    }, resolve);
    req.end();
  });
  expect(res.statusCode).toBe(404);
});
```

### 8. Port fallback test (EADDRINUSE)
This is tricky because we can't easily make port 3098 appear in use. Options:
- Mock the server.listen to simulate EADDRINUSE on first call, succeed on second
- OR accept this is hard to test without deeper mocking

For EADDRINUSE, keep a unit-level mock:
```typescript
it('should fall back to port 0 when 3098 is in use', async () => {
  // Mock server.listen to fail on port 3098 with EADDRINUSE, succeed on port 0
  const originalCreateServer = http.createServer;
  let callCount = 0;
  vi.stubGlobal('createServer', vi.fn().mockImplementation((handler) => {
    const server = originalCreateServer(handler);
    const originalListen = server.listen.bind(server);
    server.listen = vi.fn().mockImplementation((port: number, ...args: any[]) => {
      if (port === 3098 && callCount === 0) {
        callCount++;
        const err = new Error('EADDRINUSE') as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        process.nextTick(() => server.emit('error', err));
        return server;
      }
      return originalListen(port, ...args);
    });
    return server;
  }));
  // Test that the server starts and resolves to a URL
});
```

## Acceptance Criteria
- [ ] All httpTransport tests use makePostRequest/makeGetRequest (real HTTP)
- [ ] No `simulateReadJsonBody` or `simulateHttpRequest` helper functions exist
- [ ] Tests make real HTTP requests to the real server
- [ ] Body size boundary tests work correctly (413 for >2MB, pass for ≤2MB)
- [ ] Empty/malformed JSON returns proper 400 JSON-RPC responses
- [ ] Tests pass with `npm run test`
