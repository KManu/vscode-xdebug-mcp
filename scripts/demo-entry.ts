// Bundle entry for the standalone demo: exports the production server surface
// plus session tracking (normally wired by extension.ts) so breakpoint
// verification resolves exactly as it does inside VS Code.
export { startHttpServer, stopHttpServer, getLastKnownUri } from '../src/mcp/httpTransport';
export { registerSessionTracking } from '../src/debug/dapBridge';
