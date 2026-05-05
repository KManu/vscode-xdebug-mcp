# Phase 3bR — Add Real MCP Protocol Integration Tests

## Context
Phase 3aR fixed httpTransport to use real HTTP. Now we need to add integration tests that exercise the full MCP protocol exchange over HTTP — not just transport-level things like body size, but actual JSON-RPC request/response over the real server.

## Goal
Add integration tests that make real HTTP POST/GET requests and verify actual MCP JSON-RPC responses from the real server.

## Files to Modify
- `src/__tests__/httpTransport.test.ts` — add integration tests

## MCP Protocol Basics
MCP uses JSON-RPC 2.0 over HTTP:
- POST with `Content-Type: application/json` sends JSON-RPC request
- Response is also JSON-RPC
- GET is used for SSE streaming responses

## Integration Tests to Add

### 1. JSON-RPC tool call via POST
```typescript
it('should handle a JSON-RPC tools/call request', async () => {
  const jsonRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'threads',
      arguments: {}
    }
  };

  const res = await makePostRequest(JSON.stringify(jsonRpcRequest));

  // The real MCP server should process this and return a JSON-RPC response
  // Even if the debug session doesn't exist, it should be a valid JSON-RPC response
  expect(res.statusCode).toBe(200);
  const response = JSON.parse(res.body);
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(1);
});
```

### 2. JSON-RPC initialize request
```typescript
it('should handle JSON-RPC initialize request', async () => {
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' }
    }
  };

  const res = await makePostRequest(JSON.stringify(initRequest));
  expect(res.statusCode).toBe(200);
  const response = JSON.parse(res.body);
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(1);
  expect(response.result).toBeDefined();
});
```

### 3. Invalid JSON-RPC method
```typescript
it('should return method not found for unknown method', async () => {
  const badRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'unknown/method',
    params: {}
  };

  const res = await makePostRequest(JSON.stringify(badRequest));
  // Should return a valid JSON-RPC error response
  const response = JSON.parse(res.body);
  expect(response.jsonrpc).toBe('2.0');
  expect(response.error).toBeDefined();
});
```

### 4. GET request for SSE (session endpoint)
```typescript
it('should handle GET request for SSE endpoint', async () => {
  const res = await makeGetRequest();
  // Should get some response (MCP may send initial data or keep connection open)
  expect([200, 400, 404]).toContain(res.statusCode);
});
```

### 5. Request without Content-Type header
```typescript
it('should handle request without Content-Type', async () => {
  return new Promise((resolve) => {
    const url = new URL(serverUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
    }, (res) => {
      // Should still process or return error
      expect(res.statusCode).toBeDefined();
      resolve(undefined);
    });
    req.write('{}');
    req.end();
  });
});
```

## MCP Mock Setup
The makeServer mock returns a mock MCP server. For integration tests that need real MCP behavior, we should either:
1. Use a real McpServer instance (but that needs a real DAP bridge)
2. Keep the mock but verify the transport receives correct requests

For now, add integration tests that verify the HTTP transport layer handles JSON-RPC correctly, even with mocked MCP server below.

## Acceptance Criteria
- [ ] At least 5 new integration tests for MCP over HTTP
- [ ] Tests make real HTTP requests and parse real JSON-RPC responses
- [ ] Tests verify JSON-RPC response structure (jsonrpc, id, result/error)
- [ ] All tests pass with `npm run test`
