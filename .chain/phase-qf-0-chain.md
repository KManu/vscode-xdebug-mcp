# Phase qf-0 — Preliminary Checks

## Goal
Verify the current state of the codebase before starting fixes. Confirm tests pass and types are clean.

## Tasks

### 1. Run tests
```bash
npm run test
```
- All 149 tests should pass
- Note the exact count

### 2. Type check
```bash
npm run check-types
```
- Should pass cleanly

### 3. Check git state
```bash
git status
git log --oneline -3
```
- Note any uncommitted changes

### 4. Read review artifacts
Skim the 3 review artifacts (paths in orchestrator.md) to confirm findings.

## Acceptance Criteria

- [ ] `npm run test` passes (>140 tests)
- [ ] `npm run check-types` passes clean
- [ ] Working tree is clean (or only `.chain/`, `.pi/`, `ARCHITECTURE.md` changes)
- [ ] Review artifacts accessible and readable
- [ ] Output `<promise>PHASE qf-0 COMPLETE</promise>`
