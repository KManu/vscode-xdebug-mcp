// scripts/setup-e2e-win.js
// One-time (idempotent) setup for the native XAMPP+Xdebug e2e tests.
//
// Works around @vscode/test-electron@2.5.2's broken extraction of the current
// split-structure VS Code Windows archives (product.json lands in a commit
// subfolder the test runner doesn't read → infinite re-download loop) by
// pointing vscode-test at the user's ALREADY-INSTALLED VS Code instead of
// downloading one. The user's install is intact and works.
//
// This script:
//   1. Locates the local VS Code (Code.exe) — env VSCODE_E2E_PATH, then PATH
//      `code`, then common Windows install locations.
//   2. Pre-installs the `xdebug.php-debug` adapter into .vscode-test/extensions/
//      (the extensions-dir test-electron uses for the test instance) — needed so
//      `type: 'php'` debug sessions resolve without installExtensions (which
//      would trigger the broken download).
//   3. Writes the located Code.exe path to .vscode-test/.vscode-path, which
//      .vscode-test.js reads to set useInstallation.fromPath.
//
// Re-running is safe (idempotent). Exits non-zero if VS Code can't be found.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const VSCODE_TEST_DIR = path.join(REPO, '.vscode-test');
const EXTENSIONS_DIR = path.join(VSCODE_TEST_DIR, 'extensions');
const PATH_FILE = path.join(VSCODE_TEST_DIR, '.vscode-path');
const ADAPTER_EXT = 'xdebug.php-debug';

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findVsCode() {
  // 1. explicit env override
  if (process.env.VSCODE_E2E_PATH && exists(process.env.VSCODE_E2E_PATH)) {
    return process.env.VSCODE_E2E_PATH;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  // PATH lookup via `where code` (Windows) — returns the bin shim; resolve to Code.exe
  try {
    const where = cp.execSync('where code', { encoding: 'utf8' }).trim().split(/\r?\n/);
    for (const bin of where) {
      const dir = path.dirname(bin);
      const exe = path.join(dir, '..', 'Code.exe'); // bin/ is one level below Code.exe
      if (exists(exe)) return exe;
    }
  } catch {
    /* `code` not on PATH */
  }
  return null;
}

function findCodeCli(vsCodeExe) {
  // bin/code.cmd next to Code.exe — used for --install-extension (CLI mode)
  const dir = path.dirname(vsCodeExe);
  const cands = [
    path.join(dir, 'bin', 'code.cmd'),
    path.join(dir, 'bin', 'code'),
    path.join(dir, 'bin', 'code-insiders.cmd'),
  ];
  for (const c of cands) {
    if (exists(c)) return c;
  }
  return vsCodeExe; // fall back to the exe directly
}

function ensureAdapterInstalled(cliPath) {
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });
  console.log(`[setup-e2e-win] installing ${ADAPTER_EXT} into ${path.relative(REPO, EXTENSIONS_DIR)} ...`);
  const r = cp.spawnSync(
    `"${cliPath}"`,
    ['--extensions-dir', `"${EXTENSIONS_DIR}"`, '--install-extension', ADAPTER_EXT],
    { shell: true, encoding: 'utf8' }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  if (/successfully installed/i.test(out)) {
    console.log(`[setup-e2e-win] ${ADAPTER_EXT} installed.`);
  } else if (/already installed|Già installato/i.test(out)) {
    console.log(`[setup-e2e-win] ${ADAPTER_EXT} already installed.`);
  } else if (r.status === 0) {
    console.log(`[setup-e2e-win] ${ADAPTER_EXT} install completed.`);
  } else {
    console.error(`[setup-e2e-win] WARNING: adapter install exit ${r.status}:\n${out.slice(-400)}`);
  }
}

function main() {
  const vsCodeExe = findVsCode();
  if (!vsCodeExe) {
    console.error('[setup-e2e-win] Could not locate VS Code (Code.exe). Set VSCODE_E2E_PATH to its path.');
    process.exit(1);
  }
  console.log(`[setup-e2e-win] VS Code found: ${vsCodeExe}`);

  // sanity: it must have the MCP API (registerMcpServerDefinitionProvider) — check product.json
  const buildDir = fs.readdirSync(path.dirname(vsCodeExe)).find((d) => /^[0-9a-f]+$/i.test(d));
  const productJson = buildDir
    ? path.join(path.dirname(vsCodeExe), buildDir, 'resources', 'app', 'product.json')
    : null;
  if (productJson && exists(productJson)) {
    try {
      const p = JSON.parse(fs.readFileSync(productJson, 'utf8'));
      const ver = p.version;
      const hasMcp = /registerMcpServerDefinition|McpServerDefinition/i.test(fs.readFileSync(productJson, 'utf8'));
      console.log(
        `[setup-e2e-win] VS Code version ${ver} — MCP API: ${hasMcp ? 'present ✓' : 'MISSING ✗ (extension may fail to activate)'}`
      );
    } catch {
      /* ignore */
    }
  }

  const cli = findCodeCli(vsCodeExe);
  ensureAdapterInstalled(cli);

  fs.mkdirSync(VSCODE_TEST_DIR, { recursive: true });
  fs.writeFileSync(PATH_FILE, vsCodeExe, 'utf8');
  console.log(`[setup-e2e-win] wrote path → ${path.relative(REPO, PATH_FILE)}`);
  console.log('[setup-e2e-win] done.');
}

main();
