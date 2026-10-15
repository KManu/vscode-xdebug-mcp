// scripts/verify-mock-dap.js
// Verifies that the mock debug adapter covers all customRequest calls in dapBridge.ts.
const fs = require('node:fs');

const dapBridge = fs.readFileSync('src/debug/dapBridge.ts', 'utf8');
const mockAdapter = fs.readFileSync('src/test/fixtures/mockDebugAdapter.ts', 'utf8');

const customRequests = [...dapBridge.matchAll(/customRequest\('(\w+)'/g)].map((m) => m[1]);
const mockCases = [...mockAdapter.matchAll(/case\s+'(\w+)'\s*:/g)].map((m) => m[1]);
const missing = customRequests.filter((r) => !mockCases.includes(r));

if (missing.length) {
  console.error('ERROR: Mock adapter is missing handlers for:', missing.join(', '));
  process.exit(1);
}
console.log(`OK: All ${customRequests.length} customRequest messages covered by mock adapter.`);
