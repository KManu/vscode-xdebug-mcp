# Phase 1b — dapBridge Path Resolution Tests

## Goal
Test `resolveFileUri()` in `src/debug/dapBridge.ts` — handles file paths, workspace folder resolution, and URI conversion.

## What to Test

### `resolveFileUri(file, sessionId?)` in dapBridge.ts

**Test cases:**
1. **`vscode.Uri` input** → returned as-is (already resolved)
2. **Absolute Unix path** (starts with `/`) → `vscode.Uri.file()` result
3. **Windows drive path** (e.g., `C:\path`) → `vscode.Uri.file()` result
4. **Workspace-relative path** → resolved against first workspace folder
5. **Relative path not in first folder** → searched in subsequent folders
6. **Non-existent relative path** → returned as `firstFolder.joinPath(relative)`

## How to Implement

1. Read `src/debug/dapBridge.ts` — find `resolveFileUri()` and understand its logic
2. Note how it uses `vscode.workspace.workspaceFolders` to search folders
3. Create tests with different `workspaceFolders` mock configurations
4. Test each path type with the appropriate mock folder setup

**Key mock details:**
- `vscode.workspace.workspaceFolders` — array of `WorkspaceFolder` objects
- Each `WorkspaceFolder` has `uri: vscode.Uri` with `fsPath` property
- `vscode.Uri.file()` and `vscode.Uri.parse()` should return mock URIs
- `workspaceFolder.uri.fsPath` is used for path comparisons

## Verification

- Each test case exercises the actual code path
- Verify `Uri.file()` is called correctly for absolute paths
- Verify workspace folder search follows the correct order