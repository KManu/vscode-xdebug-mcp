# Review Phase 3 — httpTransport.test.ts

## Goal
Review httpTransport.test.ts for correctness and real HTTP testing.

## What to Review

Read `src/__tests__/httpTransport.test.ts` and `src/mcp/httpTransport.ts` and verify:

### 1. Tests use real HTTP
- No `simulateReadJsonBody` or `simulateHttpRequest` helper functions
- Tests call `makePostRequest`, `makeGetRequest`, or `makeRawRequest` with real HTTP
- Real server started via `startHttpServer()`

### 2. Body size limit tests
- Body > 2MB → 413 status
- Body = exactly 2MB → not 413
- Body < 2MB → not 413
- JSON-RPC error response structure correct for 413

### 3. Parse error tests
- Empty body → 400
- Malformed JSON → 400
- JSON-RPC error response structure correct for 400

### 4. Port fallback test
- EADDRINUSE on 3098 → fallback to port 0
- Other errors → propagate

### 5. Header normalization tests
- POST without accept → normalized
- POST without content-type → added
- GET without accept → normalized

### 6. Listener cleanup
- res.off() called if available
- res.removeListener() called as fallback

### 7. MCP protocol integration tests
- initialize request → JSON-RPC response with result
- tools/call request → JSON-RPC response
- Unknown method → method not found error
- GET request → SSE response

## Issues to Look For
- Tests that re-implement logic instead of testing real server
- Hardcoded ports instead of using serverUrl from startHttpServer
- ECONNRESET handling that masks real failures
- Missing cleanup (server not stopped between tests)

## Tasks
1. Read the test file
2. Read the corresponding source file
3. Identify any bugs, gaps, or issues
4. Fix them directly
5. Run `npm run test` to verify tests still pass
6. Report what was found and fixed
