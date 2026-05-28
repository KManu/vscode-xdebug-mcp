// .vscode-test.js
const { defineConfig } = require('@vscode/test-cli');
const path = require('path');

const testWorkspace = path.resolve(__dirname, 'src/test/fixtures/test-workspace');

module.exports = defineConfig({
  files: 'out/test/src/test/suite/**/*.test.js',
  version: 'stable',
  workspaceFolder: testWorkspace,
  mocha: {
    ui: 'bdd',
    timeout: 30000,
    color: true,
    require: path.resolve(__dirname, 'out/test/src/test/setup.js'),
  },
});
