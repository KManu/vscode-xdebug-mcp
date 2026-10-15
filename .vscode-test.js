// .vscode-test.js
const { defineConfig } = require('@vscode/test-cli');
const path = require('node:path');
const fs = require('node:fs');

const testWorkspace = path.resolve(__dirname, 'src/test/fixtures/test-workspace');

const mocha = {
  ui: 'bdd',
  timeout: 90000,
  color: true,
  require: path.resolve(__dirname, 'out/test/src/test/setup.js'),
};

// `test:e2e:win` runs ONLY the native XAMPP+Xdebug e2e (no Docker dependency).
// The Docker e2e (xdebugE2E.test.ts) self-skips unless run via `test:e2e`
// (see its before() guard), so other runners stay reliable without Docker.
if (process.env.npm_lifecycle_event === 'test:e2e:win') {
  mocha.grep = 'Xdebug E2E Native';
}

// Use the user's INSTALLED VS Code when scripts/setup-e2e-win.js has located it.
// This avoids @vscode/test-electron@2.5.2's broken extraction of the current
// split-structure VS Code Windows archives (product.json lands in a commit
// subfolder the runner doesn't read → infinite re-download loop). The
// `xdebug.php-debug` adapter is pre-installed into .vscode-test/extensions/ by
// the setup script (the extensions-dir test-electron uses), so `type: 'php'`
// resolves without installExtensions (which would trigger the broken download).
const vscodePathFile = path.join(__dirname, '.vscode-test', '.vscode-path');
let useInstallation;
try {
  if (fs.existsSync(vscodePathFile)) {
    useInstallation = {
      fromPath: fs.readFileSync(vscodePathFile, 'utf8').trim(),
    };
  }
} catch {
  /* ignore — fall back to download below */
}

const config = {
  files: 'out/test/src/test/suite/**/*.test.js',
  workspaceFolder: testWorkspace,
  mocha,
};
if (useInstallation) {
  config.useInstallation = useInstallation;
} else {
  // Fallback for machines where the standard download works.
  config.version = '1.130.0';
  config.installExtensions = ['xdebug.php-debug'];
}

module.exports = defineConfig(config);
