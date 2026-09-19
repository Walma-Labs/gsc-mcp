// Pure tool logic — everything that can be tested without Google. Ported
// line-for-line in behavior from the original Python implementation
// (gsc_mcp/server.py): same defaults, same rounding, same aggregation.

export const DIMENSIONS = ["date", "query", "page", "country", "device", "searchAppearance"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Filter {
  dimension: string;
  operator: string;
  expression: string;
}

export interface MetricRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  [dim: string]: unknown;
}

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round((v + Number.EPSILON) * f) / f;
};

/** Default range: 28 days ending 2 days ago (Search Analytics lags ~2 days). */
export function defaultRange(days = 28, today = new Date()): { start: string; end: string } {
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export function buildFilterGroups(filters?: Filter[] | null): Array<{ filters: Filter[] }> {
  if (!filters || filters.length === 0) return [];
  return [{ filters }];
}

export function assertDimensions(dimensions?: string[] | null): void {
  if (!dimensions) return;
  const bad = dimensions.filter(d => !(DIMENSIONS as readonly string[]).includes(d));
  if (bad.length) {
    throw new Error(`Unknown dimensions: ${JSON.stringify(bad.sort())}. Allowed: ${JSON.stringify([...DIMENSIONS].sort())}`);
  }
}

/** Map raw API rows (keys array) into flat rows keyed by dimension name. */
export function mapRows(apiRows: any[] | undefined, dimensions: string[]): MetricRow[] {
  return (apiRows ?? []).map((r) => {
    const row: MetricRow = {
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: round(r.ctr ?? 0, 4),
      position: round(r.position ?? 0, 2),
    };
    dimensions.forEach((d, i) => { row[d] = (r.keys ?? [])[i]; });
    return row;
  });
}

export function clampRowLimit(rowLimit: number): number {
  return Math.max(1, Math.min(rowLimit, 25000));
}

export interface Aggregate {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Site-wide aggregate with impression-weighted average position. */
export function aggregate(rows: MetricRow[]): Aggregate {
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const imps = rows.reduce((a, r) => a + r.impressions, 0);
  const pos = imps ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / imps : 0;
  return {
    clicks,
    impressions: imps,
    ctr: imps ? round(clicks / imps, 4) : 0,
    position: round(pos, 2),
  };
}

export function deltas(a: Aggregate, b: Aggregate): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of ["clicks", "impressions", "ctr", "position"] as const) {
    out[k] = round(a[k] - b[k], 4);
  }
  out.clicks_pct = b.clicks ? round(((a.clicks - b.clicks) / b.clicks) * 100, 1) : null;
  return out;
}

const ZERO: Aggregate = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/** Per-dimension comparison: top keys by current clicks, zeros where absent. */
export function compareByDimension(
  cur: MetricRow[],
  prev: MetricRow[],
  dimension: string,
  rowLimit: number,
) {
  const byKey = (rows: MetricRow[]) => new Map(rows.map(r => [String(r[dimension]), r]));
  const curBy = byKey(cur);
  const prevBy = byKey(prev);
  const keys = [...new Set([...curBy.keys(), ...prevBy.keys()])]
    .sort((a, b) => (curBy.get(b)?.clicks ?? 0) - (curBy.get(a)?.clicks ?? 0))
    .slice(0, rowLimit);
  const metrics = (r?: MetricRow): Aggregate => r
    ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }
    : { ...ZERO };
  return keys.map((k) => {
    const c = metrics(curBy.get(k));
    const p = metrics(prevBy.get(k));
    return { [dimension]: k, current: c, previous: p, delta: deltas(c, p) };
  });
}
