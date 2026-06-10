# Phase 2b — server structuredContent Verification Tests

## Goal
Test that all MCP tool results in `src/mcp/server.ts` correctly attach `structuredContent` with the expected shape.

## What to Test

### Every tool result has `structuredContent`

For each tool, verify the response has:
```typescript
{
  content: [
    {
      type: "text",
      text: "...", // human-readable summary
    }
  ],
  structuredContent: {
    success: true,
    // tool-specific data
  }
}
```

## How to Implement

1. Read `src/mcp/server.ts` — find where tools construct their return values
2. For each tool, mock the DAP bridge responses
3. Call the tool handler
4. Assert `structuredContent` exists and has `success: true`
5. Assert `structuredContent` contains the tool-specific data

**Example for `threads` tool:**
```typescript
// Mock DAP threads response
mockDapBridge.threads.mockResolvedValue([{ id: '1', name: 'main' }]);
const result = await toolHandlers.threads({});
expect(result.structuredContent).toBeDefined();
expect(result.structuredContent.success).toBe(true);
expect(result.structuredContent.threads).toHaveLength(1);
```

## Tools to Verify

- `threads`, `status`, `stack`, `scopes`, `variables`
- `set_breakpoint`, `set_logpoint`, `clear_breakpoints`
- `set_function_breakpoints`, `set_exception_breakpoints`
- `continue`, `pause`, `step_over`, `step_in`, `step_out`
- `restart`, `terminate`, `disconnect`, `evaluate_expr`, `wait_for_stop`, `snapshot`

## Verification

- Every tool returns `structuredContent` with `success: true`
- Tool-specific data fields are present and correctly shaped