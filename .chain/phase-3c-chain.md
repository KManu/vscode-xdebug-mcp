# Phase 3c — httpTransport Port Fallback and Header Tests

## Goal
Test port fallback logic and header normalization in `src/mcp/httpTransport.ts`.

## What to Test

### Port Fallback

**Test cases:**
1. **Port 3098 available** → server listens on 3098
2. **Port 3098 in use (EADDRINUSE)** → falls back to port 0 (OS-assigned)
3. **Other port errors** → propagate as errors

**How to test:**
- Mock `server.listen()` to call callback with `EADDRINUSE` error on first call
- Verify second call with port 0 succeeds
- Check `server.address()` returns the fallback port

### Header Normalization

**Test cases:**
1. **POST without `accept`** → added `accept: application/json, text/event-stream`
2. **POST with existing `accept`** → kept as-is
3. **GET without `accept`** → added `accept: text/event-stream`
4. **Missing `content-type` on POST** → added `content-type: application/json`

**How to test:**
- Mock incoming request with various header configurations
- After header normalization, verify the transport has correct headers set

### Listener Cleanup

**Test cases:**
1. **Response close event** → `res.off()` or `res.removeListener()` called
2. **Both `off` and `removeListener` tested** (code uses whichever exists)

## How to Implement

1. Read `src/mcp/httpTransport.ts` — find `startHttpServer()` and `handleRequest()`
2. Port fallback is in the `listen()` callback error handling
3. Header normalization is in the request handler before creating transport
4. Listener cleanup is in the `finally` block after `res.end()`

## Verification

- Port fallback works on EADDRINUSE
- Headers are normalized correctly for POST and GET
- Event listeners are cleaned up properly