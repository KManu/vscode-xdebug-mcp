# Phase 3b — httpTransport Parse Error Tests

## Goal
Test JSON parse error handling in `src/mcp/httpTransport.ts`.

## What to Test

### Parse error handling

**Test cases:**
1. **Empty body** → 400 JSON-RPC parse error
2. **Malformed JSON** → 400 JSON-RPC parse error
3. **Valid JSON** → passes through to MCP handler

**Expected JSON-RPC error shape:**
```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32700,
    "message": "Parse error"
  }
}
```

## How to Implement

1. Read `src/mcp/httpTransport.ts` — find where JSON parsing happens
2. Parse errors happen in the JSON body parsing try/catch
3. Create mock `IncomingMessage` with malformed body data
4. Verify 400 response with correct JSON-RPC error

**Note:** The 413 (payload too large) and 400 (parse error) are different code paths — make sure to test both.

## Mocking Strategy

Same as Phase 3a — mock `node:http` module with controlled incoming message body.

## Verification

- Empty body triggers 400 parse error
- Any invalid JSON triggers 400 parse error
- Valid JSON passes to handler