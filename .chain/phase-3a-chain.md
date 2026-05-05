# Phase 3a — httpTransport Body Limit Tests

## Goal
Test the 2MB body size limit enforcement in `src/mcp/httpTransport.ts`.

## What to Test

### Body size enforcement (MAX_BODY_BYTES = 2 * 1024 * 1024)

**Test cases:**
1. **Body < 2MB** → parses successfully
2. **Body = exactly 2MB** → parses successfully
3. **Body > 2MB** → returns 413 Payload Too Large with JSON-RPC error

**Boundary values:**
- 0 bytes → 400 parse error (not 413)
- 1 byte → parses
- 2,097,152 bytes (2MB) → parses
- 2,097,153 bytes → 413

## How to Implement

1. Read `src/mcp/httpTransport.ts` — find `MAX_BODY_BYTES` constant and body parsing logic
2. The limit is enforced in the `IncomingMessage` data handler — body is destroyed if over limit
3. Create mock `IncomingMessage` that lets you control body size
4. Verify 413 response has correct JSON-RPC error structure:
   ```json
   {
     "jsonrpc": "2.0",
     "error": {
       "code": "E",
       "message": "Payload too large"
     }
   }
   ```

## Mocking Strategy

Mock `node:http` module:
- `createServer()` returns mock server
- `IncomingMessage` mock lets you emit data chunks of any size
- `ServerResponse` mock captures `statusCode`, `setHeader()`, `end()` calls

## Verification

- Bodies at or under limit parse normally
- Bodies over limit return 413 with correct error code
- JSON parse errors return 400 (not 413)