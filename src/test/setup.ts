// src/test/setup.ts — loaded via mocha.require in .vscode-test.js before any test files run.
// Registers the mock debug adapter at module load time (synchronously, before any test executes)
// so that vscode.debug.startDebugging() can find the 'xdebug-mcp-test' type.
import { registerMockDebugAdapter, unregisterMockDebugAdapter } from './fixtures/mockDebugAdapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PORT_FILE = path.join(os.homedir(), '.vscode-xdebug-mcp', 'port.json');

// Register at module load time — must happen before any test file runs.
// Mocha's --require loads this file and executes it synchronously before
// loading any test suites.
registerMockDebugAdapter();

// Port file cleanup at module load time: only remove if PID is dead.
try {
  const data = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
  try {
    process.kill(data.pid, 0); // alive — preserve
  } catch {
    fs.unlinkSync(PORT_FILE); // dead — safe to remove
  }
} catch {
  // file doesn't exist or is malformed — fine
}

// Cleanup on process exit (runs after all tests complete).
process.on('exit', () => {
  try {
    unregisterMockDebugAdapter();
  } catch {}
});
