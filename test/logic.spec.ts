// Pure-logic parity tests — the behaviors ported from gsc_mcp/server.py:
// default range, clamping, dimension validation, rounding, weighted position,
// deltas, and the top-by-current-clicks comparison with zero-fill.

import { describe, it, expect } from "vitest";
import {
  aggregate, assertDimensions, buildFilterGroups, clampRowLimit,
  compareByDimension, defaultRange, deltas, mapRows,
} from "../src/logic.js";

describe("defaultRange", () => {
  it("is 28 days ending 2 days ago", () => {
    const { start, end } = defaultRange(28, new Date("2026-09-20T12:00:00Z"));
    expect(end).toBe("2026-09-18");
    expect(start).toBe("2026-08-22");
  });
});

describe("clampRowLimit", () => {
  it("clamps to 1..25000", () => {
    expect(clampRowLimit(0)).toBe(1);
    expect(clampRowLimit(100)).toBe(100);
    expect(clampRowLimit(99999)).toBe(25000);
  });
});

describe("assertDimensions", () => {
  it("accepts the known set and rejects strangers with the same message shape", () => {
    expect(() => assertDimensions(["date", "query"])).not.toThrow();
    expect(() => assertDimensions(["bogus"])).toThrowError(/Unknown dimensions: \["bogus"\]/);
  });
});

describe("mapRows", () => {
  it("zips dimension keys and rounds ctr(4)/position(2)", () => {
    const rows = mapRows(
      [{ keys: ["cats", "SE"], clicks: 10, impressions: 100, ctr: 0.12345, position: 3.14159 }],
      ["query", "country"],
    );
    expect(rows[0]).toEqual({
      query: "cats", country: "SE", clicks: 10, impressions: 100, ctr: 0.1235, position: 3.14,
    });
  });
});

describe("buildFilterGroups", () => {
  it("wraps filters in one ANDed group, empty for none", () => {
    expect(buildFilterGroups(undefined)).toEqual([]);
    const f = [{ dimension: "query", operator: "contains", expression: "cat" }];
    expect(buildFilterGroups(f)).toEqual([{ filters: f }]);
  });
});

describe("aggregate + deltas", () => {
  const rows = [
    { clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
    { clicks: 0, impressions: 300, ctr: 0, position: 10 },
  ];
  it("weights position by impressions", () => {
    const a = aggregate(rows as any);
    expect(a.clicks).toBe(10);
    expect(a.impressions).toBe(400);
    expect(a.ctr).toBe(0.025);
    expect(a.position).toBe(8); // (2*100 + 10*300) / 400
  });
  it("computes clicks_pct with null on zero base", () => {
    const a = aggregate(rows as any);
    const zero = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    expect(deltas(a, zero).clicks_pct).toBeNull();
    expect(deltas(a, { ...zero, clicks: 5 }).clicks_pct).toBe(100);
  });
});

describe("compareByDimension", () => {
  it("orders by current clicks, zero-fills missing sides, respects the limit", () => {
    const cur = mapRows(
      [
        { keys: ["a"], clicks: 5, impressions: 50, ctr: 0.1, position: 4 },
        { keys: ["b"], clicks: 50, impressions: 500, ctr: 0.1, position: 2 },
      ],
      ["query"],
    );
    const prev = mapRows([{ keys: ["c"], clicks: 7, impressions: 70, ctr: 0.1, position: 6 }], ["query"]);
    const rows = compareByDimension(cur, prev, "query", 2);
    expect(rows.map(r => r.query)).toEqual(["b", "a"]); // c cut by the limit
    expect(rows[0]!.previous.clicks).toBe(0);            // zero-filled
    const all = compareByDimension(cur, prev, "query", 10);
    const c = all.find(r => r.query === "c")!;
    expect(c.current.clicks).toBe(0);
    expect(c.previous.clicks).toBe(7);
  });
});
