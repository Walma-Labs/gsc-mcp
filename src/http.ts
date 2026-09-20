// Streamable-HTTP entrypoint — stateless, one server instance per request,
// mirroring the pattern proven by Walma's Impuls MCP server. Suitable for
// running standalone in a container (PORT env) or as a reference for mounting
// createGscServer() behind another HTTP host.
//
// No auth here by design: in the Walma deployment the gateway relay
// authenticates callers before this process is reachable. If you expose this
// directly, put your own auth in front.

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGscServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (req.method !== "POST") {
    // Stateless mode: no GET event stream, no session to DELETE.
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }
  try {
    const server = createGscServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.error(`gsc-mcp listening on http://0.0.0.0:${PORT} (streamable HTTP, stateless)`);
});
