# Phase 0 — Test Infrastructure

## Goal
Set up the complete test infrastructure: Vitest config, mockVscode helpers, and package.json additions.

## Files to Create

1. **`vitest.config.ts`** — Vitest configuration with:
   - TypeScript path aliases (`src/*` → `./src/*`)
   - `environment: 'node'`
   - `pool: 'forks'` (for isolation)
   - Mock setup for VS Code globals

2. **`src/__tests__/mockVscode.ts`** — Reusable VS Code API mocks:
   - `createMockDebugSession(overrides?)` — returns mock DebugSession with `id`, `name`, `type`, `workspaceFolder`, `customRequest`
   - `createMockWorkspaceFolder(path)` — returns mock WorkspaceFolder with `uri: vscode.Uri`
   - `mockVscodeDebug()` — sets up all `vi.mock('vscode')` for debug module
   - `mockVscodeWorkspace()` — sets up `vi.mock('vscode')` for workspace module
   - `mockVscodeUri()` — mocks `vscode.Uri.file()`, `Uri.parse()`, `Uri.joinPath()`

3. **`package.json`** additions (via Edit, not overwrite):
   - Add `"test": "vitest run"` and `"test:watch": "vitest watch"` scripts
   - Add `"vitest": "^2.0.0"` to devDependencies

## Acceptance Criteria

- [ ] `vitest.config.ts` exists and passes TypeScript check
- [ ] `src/__tests__/` directory exists
- [ ] `src/__tests__/mockVscode.ts` exports all mock helper functions
- [ ] `mockVscode.ts` uses `vi.mock()` properly for vscode module
- [ ] `package.json` has `test` and `test:watch` scripts
- [ ] `npm run check-types` passes with new files
- [ ] `npm run test` (when tests exist) would run successfully