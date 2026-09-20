// The MCP server factory: five read-only Search Console tools on
// @modelcontextprotocol/sdk. One implementation, three consumers — the stdio
// bin (local use), the standalone HTTP entrypoint, and the Walma MCP chassis
// (which imports createGscServer and mounts it on a path).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGscClient, type GscClient } from "./gsc.js";
import {
  DIMENSIONS, aggregate, assertDimensions, buildFilterGroups, clampRowLimit,
  compareByDimension, defaultRange, deltas, mapRows, type Filter,
} from "./logic.js";

export const INSTRUCTIONS =
  "Google Search Console data via service account. Site URLs are either " +
  "'sc-domain:example.com' (domain property) or 'https://example.com/' " +
  "(URL-prefix property). Call list_sites first if unsure. Search Analytics " +
  "data lags ~2 days behind today.";

const filterSchema = z.object({
  dimension: z.string().describe("query | page | country | device | searchAppearance"),
  operator: z.string().describe("equals | contains | notContains | includingRegex | excludingRegex"),
  expression: z.string(),
});

const searchTypeSchema = z.string().default("web")
  .describe("web (default), image, video, news, discover, googleNews");

/** JSON tool result in the shape MCP clients expect. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createGscServer(client: GscClient = createGscClient()): McpServer {
  const server = new McpServer(
    { name: "gsc", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool("list_sites", {
    description: "List Search Console properties the service account has access to, with the permission level for each.",
    inputSchema: {},
  }, async () => {
    const resp = await client.listSites();
    const sites = (resp.siteEntry ?? []).map((s: any) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel ?? "",
    }));
    return jsonResult(sites);
  });

  server.registerTool("search_analytics", {
    description:
      "Query Search Analytics (clicks, impressions, CTR, position). Defaults to the last " +
      "28 days ending 2 days ago. Omit dimensions for site-wide totals; use start_row to paginate.",
    inputSchema: {
      site: z.string().describe("Property URL, e.g. 'sc-domain:example.com' or 'https://example.com/'"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
      dimensions: z.array(z.enum(DIMENSIONS)).optional()
        .describe("Any of date, query, page, country, device, searchAppearance"),
      row_limit: z.number().int().default(100).describe("1-25000 (default 100)"),
      start_row: z.number().int().default(0),
      filters: z.array(filterSchema).optional().describe("Multiple filters are ANDed"),
      search_type: searchTypeSchema,
    },
  }, async (args) => {
    assertDimensions(args.dimensions);
    let { start_date, end_date } = args;
    if (!start_date || !end_date) {
      const r = defaultRange();
      start_date = r.start;
      end_date = r.end;
    }
    const body: Record<string, unknown> = {
      startDate: start_date,
      endDate: end_date,
      rowLimit: clampRowLimit(args.row_limit),
      startRow: Math.max(0, args.start_row),
      type: args.search_type,
      dataState: "final",
    };
    if (args.dimensions?.length) body.dimensions = args.dimensions;
    const fg = buildFilterGroups(args.filters as Filter[] | undefined);
    if (fg.length) body.dimensionFilterGroups = fg;

    const resp = await client.queryAnalytics(args.site, body);
    const rows = mapRows(resp.rows, args.dimensions ?? []);
    return jsonResult({
      site: args.site,
      startDate: start_date,
      endDate: end_date,
      rowCount: rows.length,
      totals: {
        clicks: rows.reduce((a, r) => a + r.clicks, 0),
        impressions: rows.reduce((a, r) => a + r.impressions, 0),
      },
      rows,
    });
  });

  server.registerTool("compare_periods", {
    description:
      "Compare two date ranges side by side with deltas. With no dimension, site-wide totals " +
      "for both periods. With a dimension (query, page, country, device), the top rows by " +
      "current clicks with previous-period values and deltas; rows existing in only one " +
      "period are included with zeros for the other.",
    inputSchema: {
      site: z.string(),
      current_start: z.string().describe("YYYY-MM-DD"),
      current_end: z.string().describe("YYYY-MM-DD"),
      previous_start: z.string().describe("YYYY-MM-DD"),
      previous_end: z.string().describe("YYYY-MM-DD"),
      dimension: z.enum(DIMENSIONS).optional(),
      row_limit: z.number().int().default(50),
      filters: z.array(filterSchema).optional(),
      search_type: searchTypeSchema,
    },
  }, async (args) => {
    const run = async (s: string, e: string) => {
      const body: Record<string, unknown> = {
        startDate: s,
        endDate: e,
        type: args.search_type,
        dataState: "final",
        rowLimit: args.dimension ? Math.max(args.row_limit * 4, 200) : 1,
      };
      if (args.dimension) body.dimensions = [args.dimension];
      const fg = buildFilterGroups(args.filters as Filter[] | undefined);
      if (fg.length) body.dimensionFilterGroups = fg;
      const resp = await client.queryAnalytics(args.site, body);
      return mapRows(resp.rows, args.dimension ? [args.dimension] : []);
    };

    const [cur, prev] = await Promise.all([
      run(args.current_start, args.current_end),
      run(args.previous_start, args.previous_end),
    ]);

    const current = { startDate: args.current_start, endDate: args.current_end, ...aggregate(cur) };
    const previous = { startDate: args.previous_start, endDate: args.previous_end, ...aggregate(prev) };
    const result: Record<string, unknown> = {
      site: args.site,
      current,
      previous,
      delta: deltas(current, previous),
    };
    if (args.dimension) {
      result.dimension = args.dimension;
      result.rows = compareByDimension(cur, prev, args.dimension, args.row_limit);
    }
    return jsonResult(result);
  });

  server.registerTool("list_sitemaps", {
    description: "List submitted sitemaps for a property with status, last download, errors/warnings and indexed URL counts.",
    inputSchema: { site: z.string() },
  }, async (args) => {
    const resp = await client.listSitemaps(args.site);
    const sitemaps = (resp.sitemap ?? []).map((s: any) => ({
      path: s.path,
      lastSubmitted: s.lastSubmitted,
      lastDownloaded: s.lastDownloaded,
      isPending: s.isPending,
      errors: s.errors ?? 0,
      warnings: s.warnings ?? 0,
      contents: s.contents ?? [],
    }));
    return jsonResult(sitemaps);
  });

  server.registerTool("inspect_url", {
    description:
      "Run URL Inspection for a page: index status, coverage verdict, canonical (Google vs user), " +
      "last crawl, robots/indexing state, mobile and rich-result verdicts. " +
      "Quota: 2000 calls/day per property. Requires Owner or Full access.",
    inputSchema: {
      site: z.string(),
      url: z.string(),
      language: z.string().default("en-US"),
    },
  }, async (args) => {
    const resp = await client.inspectUrl({
      inspectionUrl: args.url,
      siteUrl: args.site,
      languageCode: args.language,
    });
    const r = resp.inspectionResult ?? {};
    const idx = r.indexStatusResult ?? {};
    return jsonResult({
      url: args.url,
      inspectionResultLink: r.inspectionResultLink,
      verdict: idx.verdict,
      coverageState: idx.coverageState,
      indexingState: idx.indexingState,
      robotsTxtState: idx.robotsTxtState,
      pageFetchState: idx.pageFetchState,
      lastCrawlTime: idx.lastCrawlTime,
      crawledAs: idx.crawledAs,
      googleCanonical: idx.googleCanonical,
      userCanonical: idx.userCanonical,
      referringUrls: idx.referringUrls ?? [],
      sitemap: idx.sitemap ?? [],
      mobileUsability: r.mobileUsabilityResult?.verdict,
      richResults: r.richResultsResult?.verdict,
    });
  });

  return server;
}
