# Phase 2a — server Tool Schema Validation Tests

## Goal
Test that MCP tools in `src/mcp/server.ts` correctly validate input using their Zod schemas.

## What to Test

### Each tool's Zod input schema

Test tools and their key params:

1. **`stack`** — accepts `threadId?`, `startFrame?`, `levels?` (all optional numbers/strings)
2. **`scopes`** — requires `frameId` (number)
3. **`variables`** — requires `variablesReference` (number), optional `start?`, `count?`, `filter?`
4. **`set_breakpoint`** — requires `source` (string), optional `line` (number), `condition?`, `hitCondition?`, `logMessage?`
5. **`set_logpoint`** — requires `source` (string), `line` (number), `logMessage` (string)
6. **`clear_breakpoints`** — requires `source` (string)
7. **`set_function_breakpoints`** — requires `names` (array of strings)
8. **`set_exception_breakpoints`** — requires `filters` (array of strings)
9. **`evaluate_expr`** — requires `expr` (string), optional `frameId?`
10. **`continue`**, **`pause`**, **`step_over`**, **`step_in`**, **`step_out`** — no required params
11. **`restart`**, **`terminate`**, **`disconnect`** — no required params
12. **`wait_for_stop`** — optional `timeout?` (number, milliseconds)
13. **`snapshot`** — optional `includeExpensive?`, `maxVariables?`
14. **`threads`**, **`status`** — no params

## How to Implement

1. Read `src/mcp/server.ts` — extract each tool's Zod schema
2. For each tool, write a test that passes valid input and verifies no validation error
3. For each tool with required params, write a test that passes empty/missing input and expects a validation error
4. Tools that call DAP bridge functions — mock the bridge, not the real DAP

**Note:** Tool registration uses `server.registerTool()`. You can test the schema validation by calling the tool handler directly with different inputs.

## Verification

- All valid inputs pass schema validation
- All invalid inputs (missing required, wrong types) fail with clear errors
- Error messages reference the correct field