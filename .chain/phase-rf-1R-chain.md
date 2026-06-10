# Phase rf-1R — Review Graceful Error Handling

## Goal
Review Phase rf-1 changes: verify error handling is comprehensive, messages are actionable, and no tools were missed.

## What to Inspect

### 1. `src/mcp/server.ts` — safeHandler coverage
- [ ] `safeHandler` and `errorResult` functions defined
- [ ] `errorResult` includes `structuredContent: { success: false, error: message }`
- [ ] Every `server.registerTool()` handler wrapped with `safeHandler(`
- [ ] Count: exactly 21 `registerTool` calls — all 21 wrapped
- [ ] No `list_resource_templates` regression (should still work fine)
- [ ] Tool signatures unchanged (Zod still validates before handler runs)

### 2. `src/debug/dapBridge.ts` — notStopped wrapping
- [ ] `stack()` imports and calls `isNotStoppedError`
- [ ] `scopes()` imports and calls `isNotStoppedError`
- [ ] `variables()` imports and calls `isNotStoppedError`
- [ ] `evaluate()` imports and calls `isNotStoppedError`
- [ ] All 4 error messages are identical or consistent
- [ ] Error messages reference `wait_for_stop` and `pause`
- [ ] Non-notStopped errors still propagate correctly
- [ ] No other bridge functions accidentally modified

### 3. Test impact
- [ ] `npm run test` — all 149+ tests still pass
- [ ] Verify: tests that mock errors should now receive `structuredContent: { success: false, error: "..." }` instead of a thrown error
- [ ] If any test expected a thrown error to propagate, it should now check `structuredContent.success === false`

### 4. Verification
```bash
npm run check-types
npm run test
git diff src/
```

## Acceptance Criteria

- [ ] All 21 MCP tools have structured error responses on failure
- [ ] 4 bridge inspection functions catch notStopped with actionable messages
- [ ] No tool handlers left unwrapped
- [ ] All tests pass, types clean
- [ ] No regressions in tool functionality
- [ ] Output `<promise>PHASE rf-1R REVIEWED — PASS</promise>` or `<promise>BLOCKED: reason</promise>`
