---
name: ralph-chain
description: "Ralph Chain Orchestrator — coordinator that spawns sub-agents, where each sub-agent runs a Ralph Loop for iterative refinement within its sub-phase. Combines: coordinator loop (state-driven phase sequencing) + Ralph Wiggum loop (self-referential iterations per sub-phase). Use when: user wants to run all phases automatically, chain phases together with iterative refinement, or manage multi-phase implementation with context-bounded loops. Triggers especially when user mentions 'run all phases', 'start the chain', 'orchestrate phases', or 'Ralph chain'. This skill manages vscode-xdebug-mcp test implementation phases (Phase 0 through Phase 4)."
user-invocable: true
allowed-tools: Read,Write,Edit,Bash,Agent,TaskCreate,TaskUpdate,TaskList,TaskGet
when_to_use: "user wants to run all phases automatically, chain phases with Ralph loops, spawn sub-agents for phases, or manage multi-phase implementation"
---

# Ralph Chain Orchestrator

Combines two patterns into a two-level architecture:

**Level 1 — Coordinator:** Spawns sub-agents for each sub-phase in sequence, manages state via `.chain/.current_phase`, never overflows.

**Level 2 — Sub-agent Ralph Loop:** Each sub-agent runs Ralph Wiggum Loop internally — iteratively refines the sub-phase by re-feeding the same task prompt, seeing its own prior work via files and git history.

Result: Context stays bounded per sub-phase iteration, and coordinator never overflows because it only manages state.

## Architecture

```
Coordinator Session (main Claude Code)
├── Reads .chain/.current_phase
├── Spawns sub-agent for current sub-phase
├── Updates state after each sub-phase completes
└── Loops until STATUS=complete

Sub-Agent (fresh context per sub-phase)
├── Runs Ralph Wiggum Loop internally
├── Reads sub-phase chain prompt
├── Iteratively implements, sees own prior work
├── Updates state when done
└── Exits
```

## State File Format

`.chain/.current_phase`:
```
PHASE=
SUBPHASE=
STATUS=pending
LAST_COMPLETED=
```

**STATUS values:**
- `pending` — not yet started
- `in_progress` — sub-agent Ralph loop is running
- `complete` — all phases done
- `blocked` — needs human intervention

## Sub-phase Sequence

```
0 → 1a → 1b → 1c → 1d → 2a → 2b → 2c → 3a → 3b → 3c → 4
```

**Phase 0** — Test infrastructure (vitest config, mockVscode, package.json deps)
**Phase 1** — dapBridge tests (session resolution, path resolution, breakpoint lifecycle, error detection)
**Phase 2** — server tests (MCP tool schemas, structuredContent, wait_for_stop, snapshot, resources)
**Phase 3** — httpTransport tests (body limits, parse errors, port fallback, headers, cleanup)
**Phase 4** — Integration verification (run tests, check types)

## Commands

### /ralph-chain init
Initializes the chain infrastructure. Run once before starting.
1. Creates `.chain/` directory
2. Creates `.chain/.current_phase` (PHASE=0, SUBPHASE=, STATUS=pending, LAST_COMPLETED=)
3. Scans existing test files
4. Generates per-sub-phase chain prompt files in `.chain/`

**Already done. Only re-run if you need to regenerate chain files.**

### /ralph-chain run
**Starts the coordinator for one sub-phase.** This is the main command. It processes ONE sub-phase per invocation, then exits — prompting you to re-run for the next.

The coordinator:
1. Reads `.chain/.current_phase`
2. If `STATUS=complete` → reports all done, stops
3. If `STATUS=blocked` → reports block reason, stops
4. If current sub-phase already completed → skips to next, updates state, reports "skipped"
5. Spawns a sub-agent to run a Ralph Loop for the current sub-phase
6. Waits for sub-agent to complete
7. Reads updated state
8. Reports what was completed and what to do next

**To run the full chain: re-invoke `/ralph-chain run` after each sub-phase completes.**

Alternatively, use `/loop "/ralph-chain run"` to auto-repeat:
```
/loop "/ralph-chain run" --completion-promise "ALL PHASES COMPLETE"
```

### /ralph-chain status
Reads and displays current state:
- PHASE, SUBPHASE, STATUS, LAST_COMPLETED
- How many sub-phases remain

### /ralph-chain advance [phase] [subphase]
Manually set the state to a specific position.

### /ralph-chain reset [phase]
Reset to a specific phase (marks that phase as pending).

### /ralph-chain stop
Set `STATUS=blocked` to stop the coordinator loop.

## Coordinator: One Phase Per Invocation

Each `/ralph-chain run` processes exactly one sub-phase, then exits. For automatic looping, use `/loop`:

```
/loop "/ralph-chain run" --completion-promise "ALL PHASES COMPLETE" --max-iterations 20
```

**How it works step-by-step:**

```
1. Read .chain/.current_phase
2. Determine current sub-phase (PHASE + SUBPHASE)
3. If STATUS=complete → print done, exit
4. If STATUS=blocked → print block reason, exit
5. If LAST_COMPLETED == current → advance state, print skipped, exit
6. Set STATUS=in_progress, write state
7. Spawn sub-agent (synchronous — wait for completion)
8. Sub-agent completes, updates state
9. Read new state
10. Report result and next step
11. Exit (next /ralph-chain run handles next phase)
```

## Sub-Agent: Ralph Wiggum Loop Per Sub-Phase

Each sub-agent receives a chain prompt and runs Ralph Loop internally:

```
Ralph Wiggum Loop for Phase {subphase}:
1. Read the chain prompt at .chain/phase-{subphase}-chain.md
2. Read the original spec at PLAN.md
3. Implement the sub-phase incrementally
4. Try to complete all acceptance criteria
5. Verify all work is real and correct — no hallucinations or mistakes
   - Cross-check any imports, function names, and types against the actual source files
   - Ensure all test assertions match the actual behavior of the code under test
   - Verify file paths and module references exist in the codebase
   - If any hallucination or mistake is found: fix it immediately before proceeding
6. If criteria met and verification passed:
   a. Update .chain/.current_phase:
      - Non-final sub-phase: PHASE={next}, SUBPHASE=, STATUS=pending, LAST_COMPLETED={subphase}
      - Final sub-phase (4): STATUS=complete, LAST_COMPLETED=4
   b. Exit successfully
7. If criteria NOT met:
   a. The Ralph Wiggum self-referential loop continues:
      - Claude sees its own prior work via modified files
      - Claude tries again to complete remaining criteria
      - This loop repeats until criteria are met or max iterations hit
   b. If max iterations reached without completion:
      - Set STATUS=blocked in .chain/.current_phase
      - Exit with explanation
```

**The Ralph Loop within the sub-agent provides iterative refinement.** The coordinator provides the higher-level sequencing across phases.

## State Advancement Logic (next_subphase)

```
"0" → "1a"
"1a" → "1b"
"1b" → "1c"
"1c" → "1d"
"1d" → "2a"
"2a" → "2b"
"2b" → "2c"
"2c" → "3a"
"3a" → "3b"
"3b" → "3c"
"3c" → "4"
"4" → STATUS=complete
```

## Sub-Agent Prompt Template

When spawning a sub-agent, pass this full prompt:

```
You are implementing Phase {subphase} of vscode-xdebug-mcp tests using Ralph Wiggum Loop.

## Ralph Wiggum Loop
You will iteratively refine your implementation. After each attempt:
- Review what you built and what remains
- See your prior work via modified files
- Continue until all criteria are met

## Chain Prompt
Read and implement from: .chain/phase-{subphase}-chain.md
Read the original spec: PLAN.md

## Your Task
Implement this sub-phase completely. All acceptance criteria must pass.

## Critical Verification Step
Before marking criteria as met, you MUST verify your work is not hallucinated:
- Cross-check every import, function name, and type against the actual source files
- Ensure test assertions reflect the real behavior of the code under test
- Verify file paths and module references actually exist in the codebase
- If you find ANY mistake or hallucination: fix it before proceeding

## State Update (CRITICAL — do this when done)
When all criteria are met and verified correct, update .chain/.current_phase:

For non-final sub-phase (e.g., 1a → 1b):
PHASE={next_phase}
SUBPHASE=
STATUS=pending
LAST_COMPLETED={subphase}

For phase 4 (final phase):
PHASE=4
SUBPHASE=
STATUS=complete
LAST_COMPLETED=4

## Ralph Loop Termination
After each implementation pass:
- Check if all acceptance criteria are met
- If YES and verified correct → update state, exit successfully
- If NO → continue iterating (see your work via modified files)
- **Stop after 20 iterations** if criteria still not met — set STATUS=blocked with explanation
- **Output `<promise>DONE</promise>` before exiting on success
```

## Sub-Agent Spawning

Use the Agent tool with `general-purpose` subagent type:

```
Agent(
  description = "Ralph Loop Phase {subphase}",
  prompt = "<full sub-agent prompt above>"
)
```

**Important:** Do NOT use `run_in_background = true`. The coordinator must wait synchronously for the sub-agent to complete before it can read the updated state and advance. The sub-agent's context is fresh — that's the point — so there's no benefit to backgrounding.

## Prerequisite: Git Setup

Before running `/ralph-chain run`, initialize git:
```bash
cd /home/kmanu/dev/vscode-xdebug-mcp
git init
git add .
git commit -m "Initial commit: vscode-xdebug-mcp scaffold"
```

The sub-agents use git history to see prior work. Without git, they still see modified files directly.

## Quick Start

1. **Set up git** (once):
   ```bash
   cd /home/kmanu/dev/vscode-xdebug-mcp
   git init && git add . && git commit -m "Initial"
   ```

2. **Init** (already done): `/ralph-chain init`

3. **Check state**: `/ralph-chain status`

4. **Run one phase**: `/ralph-chain run` — processes one sub-phase, then exits

5. **Auto-loop the chain** (recommended):
   ```
   /loop "/ralph-chain run" --completion-promise "ALL PHASES COMPLETE" --max-iterations 20
   ```
   The `/loop` skill invokes `/ralph-chain run` repeatedly until the promise is detected or max iterations hit.

6. **Resume**: If stopped, re-run `/ralph-chain run` — picks up from state file.

## Error Handling

- **Sub-agent blocked**: Coordinator sets STATUS=blocked. Use `/ralph-chain reset` to retry.
- **Coordinator interrupted**: State preserved. Re-run to resume.
- **Git not set up**: Sub-agents still work but can't see prior work via git history.