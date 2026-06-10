# Phase 1d — dapBridge Error Detection Tests

## Goal
Test `isNotStoppedError()` in `src/debug/dapBridge.ts` — determines if a DAP error is a "not stopped" polling error vs a fatal error.

## What to Test

### `isNotStoppedError(error)` function

**Test cases:**
1. **Error message contains "notStopped"** → returns `true`
2. **`body.error.id === 'notStopped'`** → returns `true`
3. **Combined: message has "notStopped" AND body has the id** → returns `true`
4. **Other error messages** → returns `false`
5. **Error with no body** → returns `false`
6. **Error with body but no error.id** → returns `false`

## How to Implement

1. Read `src/debug/dapBridge.ts` — find `isNotStoppedError()` and study its exact logic
2. It's a simple predicate function — easy to test with various error shapes
3. Create error objects with different shapes to test all branches

**Error shapes to test:**
```typescript
// Shape 1: message contains notStopped
{ message: 'Debugger notStopped error' }

// Shape 2: body.error.id = 'notStopped'
{ body: { error: { id: 'notStopped' } } }

// Shape 3: both
{ message: 'notStopped', body: { error: { id: 'notStopped' } } }

// Shape 4: other error
{ message: 'Some other error' }

// Shape 5: no body
{ message: 'notStopped' } // but no body

// Shape 6: body but no error.id
{ message: 'notStopped', body: { error: {} } }
```

## Verification

- Each error shape produces the expected boolean result
- Function is called correctly in `wait_for_stop` polling loop context