// Public package surface: the factory (what the Walma MCP chassis imports),
// the thin GSC client pieces, and the pure logic for anyone who wants it.

export { createGscServer, INSTRUCTIONS } from "./server.js";
export { createGscClient, createDefaultRequestFn, SCOPES, type GscClient, type RequestFn } from "./gsc.js";
export * as logic from "./logic.js";
