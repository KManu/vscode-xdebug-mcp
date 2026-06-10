---
name: ralph-review
description: "Ralph Review Chain — reviews test files for correctness, real-code coverage, and edge cases. Uses Ralph Wiggum loop for iterative refinement within each review phase. Triggers when user mentions 'review tests', 'review loop', or 'ralph-review'. This skill reviews vscode-xdebug-mcp test files (dapBridge.test.ts, server.test.ts, httpTransport.test.ts)."
user-invocable: true
allowed-tools: Read,Write,Edit,Bash,Agent,TaskCreate,TaskUpdate,TaskList,TaskGet
when_to_use: "user wants to review test files for correctness, run review loop on tests, or audit test quality"
---

# Ralph Review Chain Orchestrator

Reviews test files for correctness, real-code coverage, and edge cases.

## Architecture

```
Coordinator Session → Spawns review sub-agent for current phase → Sub-agent reviews + fixes → State updated → Repeat
```

## State File

`.chain/.review_phase`:
```
PHASE=
STATUS=pending
LAST_COMPLETED=
```

## Review Phases

```
1 → 2 → 3
```

**Phase 1** — Review dapBridge.test.ts
**Phase 2** — Review server.test.ts
**Phase 3** — Review httpTransport.test.ts

## Commands

### /ralph-review run
Processes one review phase, then exits.

### /ralph-review status
Shows current review state.

### /ralph-review reset
Reset to phase 1.

## State Advancement

```
"1" → "2"
"2" → "3"
"3" → STATUS=complete
```

## Sub-Agent Prompt

```
You are reviewing Phase {phase} of vscode-xdebug-mcp test files.

## Your Task
1. Read the review chain prompt: .chain/review-{phase}-chain.md
2. Read the test file being reviewed
3. Read the corresponding source file
4. Identify bugs, gaps, and issues
5. FIX the issues directly — do not just report them
6. Run npm run test to verify fixes don't break anything
7. Update .chain/.review_phase to next phase when done

## Verification
- All fixes must not break existing tests
- Run npm run test after each fix
- Verify tests actually test the real code (not mocks of mocks)

## State Update
When Phase N done:
PHASE={next}
STATUS=pending
LAST_COMPLETED={N}

When Phase 3 done:
PHASE=3
STATUS=complete
LAST_COMPLETED=3
Output <promise>ALL REVIEWS COMPLETE</promise>
```
