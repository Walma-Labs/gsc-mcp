#!/usr/bin/env node
// stdio entrypoint — what `npx @walma-labs/gsc-mcp` runs, for Claude Code,
// Claude Desktop (local dev servers), Cursor and any stdio MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGscServer } from "./server.js";

const server = createGscServer();
await server.connect(new StdioServerTransport());
