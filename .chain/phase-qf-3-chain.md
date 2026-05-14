# Phase qf-3 — Test Gap Coverage (W4, W5, W6, N7, N10)

## Goal
Add tests for the gaps identified in the quorum review. Target: bring test count from 149 to >160.

## Files to Modify

### 1. ADD resource handler tests to `server.test.ts` (W4)

Test cases for `xdebug://stack`:
```typescript
describe('Resource: xdebug://stack', () => {
  it('should resolve and return stack frames as JSON');
  it('should return empty array when no frames');
});

describe('Resource: xdebug://variables/{frameId}', () => {
  it('should return variables for valid frameId');
  it('should throw for non-numeric frameId');
  it('should return empty variables when frame has no scopes');
});
```

Mock `dap.stack` to return test frames. Mock `dap.scopes` to return test scopes. Mock `dap.variables` to return test variables. Register resources via `makeServer()` and call resource handlers directly.

### 2. ADD `wait_for_stop` error propagation test to `server.test.ts` (W5)

```typescript
it('should propagate non-notStopped errors', async () => {
  // Mock dap.stack to throw a non-notStopped error (e.g., network error)
  mockStack.mockRejectedValueOnce(new Error('Network error: connection refused'));
  // wait_for_stop should propagate this error, not retry
  await expect(handler({ pollMs: 10 })).rejects.toThrow('Network error');
});
```

### 3. ADD header normalization tests to `httpTransport.test.ts` (W6)

```typescript
describe('Header normalization', () => {
  it('should add Accept header to POST requests without it');
  it('should add Accept header to GET requests without it');
  it('should not override existing Accept header on POST');
  it('should not override existing Accept header on GET');
  it('should add Content-Type to POST requests without it');
});
```

Construct raw HTTP requests that omit the Accept header and verify the server injects it.

### 4. FIX dead assignment in `dapBridge.test.ts` (N7)

Find and remove the unused line (approximately line 310 in the current file):
```typescript
const uri = await dapBridge.setFileBreakpoints as any;  // REMOVE - uri is never used
```

Replace with a proper assertion if appropriate, or remove entirely:
```typescript
const result = await dapBridge.setFileBreakpoints({...});
expect(result).toBeDefined();
```

### 5. ADD `outputSchema` presence tests to `server.test.ts` (N10)

```typescript
it('set_breakpoint and set_logpoint should have outputSchema', () => {
  const server = makeServer();
  // Access registered tools and verify outputSchema is defined
  // For set_breakpoint:
  // expect(outputSchema).toEqual({ results: z.array(z.object({ verified: z.boolean(), message: z.string().optional() })) });
});
```

## Acceptance Criteria

- [ ] Resource handler tests added: `xdebug://stack` (2+ tests)
- [ ] Resource handler tests added: `xdebug://variables/{frameId}` (3+ tests)
- [ ] `wait_for_stop` error propagation test added (1 test)
- [ ] Header normalization tests added (5+ tests)
- [ ] Dead assignment in dapBridge.test.ts removed or replaced
- [ ] `outputSchema` presence tests added
- [ ] `npm run check-types` passes
- [ ] `npm run test` passes with >160 total tests
- [ ] Output `<promise>PHASE qf-3 COMPLETE</promise>`
