// Server tests: drive the real MCP wire (in-memory transport) against a mocked
// GSC client — proves tool registration, zod schemas, request-body shape sent
// to Google, and response mapping, all without network or credentials.

import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGscServer } from "../src/server.js";
import type { GscClient } from "../src/gsc.js";

function fixture() {
  const calls: Record<string, any[]> = { listSites: [], queryAnalytics: [], listSitemaps: [], inspectUrl: [] };
  const client: GscClient = {
    listSites: async () => {
      calls.listSites!.push([]);
      return { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" }] };
    },
    queryAnalytics: async (site, body) => {
      calls.queryAnalytics!.push([site, body]);
      return { rows: [{ keys: ["cats"], clicks: 12, impressions: 240, ctr: 0.05, position: 3.456 }] };
    },
    listSitemaps: async (site) => {
      calls.listSitemaps!.push([site]);
      return { sitemap: [{ path: "https://example.com/sitemap.xml", errors: 0 }] };
    },
    inspectUrl: async (body) => {
      calls.inspectUrl!.push([body]);
      return { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Indexed" } } };
    },
  };
  return { client, calls };
}

async function connect(gsc: GscClient) {
  const server = createGscServer(gsc);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

const text = (r: any) => JSON.parse(r.content[0].text);

describe("gsc MCP server", () => {
  let f: ReturnType<typeof fixture>;
  let mcp: Client;

  beforeEach(async () => {
    f = fixture();
    mcp = await connect(f.client);
  });

  it("registers exactly the five read-only tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "compare_periods", "inspect_url", "list_sitemaps", "list_sites", "search_analytics",
    ]);
  });

  it("list_sites maps entries", async () => {
    const out = text(await mcp.callTool({ name: "list_sites", arguments: {} }));
    expect(out).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" }]);
  });

  it("search_analytics sends final dataState, defaults, and maps rows + totals", async () => {
    const out = text(await mcp.callTool({
      name: "search_analytics",
      arguments: { site: "sc-domain:example.com", dimensions: ["query"] },
    }));
    const [site, body] = f.calls.queryAnalytics![0]!;
    expect(site).toBe("sc-domain:example.com");
    expect(body.dataState).toBe("final");
    expect(body.type).toBe("web");
    expect(body.rowLimit).toBe(100);
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaulted
    expect(out.totals).toEqual({ clicks: 12, impressions: 240 });
    expect(out.rows[0]).toMatchObject({ query: "cats", position: 3.46 });
  });

  it("compare_periods runs both ranges and computes deltas", async () => {
    const out = text(await mcp.callTool({
      name: "compare_periods",
      arguments: {
        site: "sc-domain:example.com",
        current_start: "2026-09-01", current_end: "2026-09-14",
        previous_start: "2026-08-18", previous_end: "2026-08-31",
        dimension: "query",
      },
    }));
    expect(f.calls.queryAnalytics!.length).toBe(2);
    const [, body] = f.calls.queryAnalytics![0]!;
    expect(body.rowLimit).toBe(200); // max(50*4, 200)
    expect(out.delta.clicks).toBe(0); // identical fixture both periods
    expect(out.rows[0]!.query).toBe("cats");
  });

  it("inspect_url flattens the inspection result", async () => {
    const out = text(await mcp.callTool({
      name: "inspect_url",
      arguments: { site: "sc-domain:example.com", url: "https://example.com/x" },
    }));
    const [body] = f.calls.inspectUrl![0]!;
    expect(body).toEqual({
      inspectionUrl: "https://example.com/x",
      siteUrl: "sc-domain:example.com",
      languageCode: "en-US",
    });
    expect(out.verdict).toBe("PASS");
    expect(out.coverageState).toBe("Indexed");
  });

  it("rejects an unknown dimension via schema (isError tool result)", async () => {
    const res: any = await mcp.callTool({
      name: "search_analytics",
      arguments: { site: "x", dimensions: ["bogus"] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid enum value.*bogus/);
    expect(f.calls.queryAnalytics!.length).toBe(0); // never reached Google
  });
});
