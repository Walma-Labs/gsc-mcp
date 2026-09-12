"""Google Search Console MCP server.

Auth: service account JSON key. Set GSC_SERVICE_ACCOUNT_FILE to the key path
and add the service account e-mail as a user on each property in Search Console.
"""
from __future__ import annotations

import os
from datetime import date, timedelta
from functools import lru_cache
from typing import Any

from google.oauth2 import service_account
from googleapiclient.discovery import build
from mcp.server.fastmcp import FastMCP

SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]
DIMENSIONS = {"date", "query", "page", "country", "device", "searchAppearance"}

mcp = FastMCP(
    "gsc",
    instructions=(
        "Google Search Console data via service account. Site URLs are either "
        "'sc-domain:example.com' (domain property) or 'https://example.com/' "
        "(URL-prefix property). Call list_sites first if unsure. Search Analytics "
        "data lags ~2 days behind today."
    ),
)


@lru_cache(maxsize=1)
def _service():
    key_file = os.environ.get("GSC_SERVICE_ACCOUNT_FILE")
    if not key_file:
        raise RuntimeError("GSC_SERVICE_ACCOUNT_FILE is not set")
    key_file = os.path.expanduser(key_file)
    if not os.path.exists(key_file):
        raise RuntimeError(f"Service account key not found: {key_file}")
    creds = service_account.Credentials.from_service_account_file(key_file, scopes=SCOPES)
    return build("searchconsole", "v1", credentials=creds, cache_discovery=False)


def _query(site: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    resp = _service().searchanalytics().query(siteUrl=site, body=body).execute()
    rows = resp.get("rows", [])
    dims = body.get("dimensions", [])
    out = []
    for r in rows:
        row = dict(zip(dims, r.get("keys", [])))
        row.update(
            clicks=r.get("clicks", 0),
            impressions=r.get("impressions", 0),
            ctr=round(r.get("ctr", 0.0), 4),
            position=round(r.get("position", 0.0), 2),
        )
        out.append(row)
    return out


def _build_filters(filters: list[dict[str, str]] | None) -> list[dict[str, Any]]:
    if not filters:
        return []
    return [{"filters": filters}]


def _default_range(days: int = 28) -> tuple[str, str]:
    end = date.today() - timedelta(days=2)
    start = end - timedelta(days=days - 1)
    return start.isoformat(), end.isoformat()


@mcp.tool()
def list_sites() -> list[dict[str, str]]:
    """List Search Console properties the service account has access to,
    with the permission level for each."""
    resp = _service().sites().list().execute()
    return [
        {"siteUrl": s["siteUrl"], "permissionLevel": s.get("permissionLevel", "")}
        for s in resp.get("siteEntry", [])
    ]


@mcp.tool()
def search_analytics(
    site: str,
    start_date: str | None = None,
    end_date: str | None = None,
    dimensions: list[str] | None = None,
    row_limit: int = 100,
    start_row: int = 0,
    filters: list[dict[str, str]] | None = None,
    search_type: str = "web",
) -> dict[str, Any]:
    """Query Search Analytics (clicks, impressions, CTR, position).

    Args:
        site: Property URL, e.g. 'sc-domain:example.com' or 'https://example.com/'.
        start_date / end_date: YYYY-MM-DD. Defaults to the last 28 days ending 2 days ago.
        dimensions: Any of date, query, page, country, device, searchAppearance.
            Omit for site-wide totals.
        row_limit: 1-25000 (default 100). Use start_row to paginate.
        filters: List of {"dimension": "query|page|country|device|searchAppearance",
            "operator": "equals|contains|notContains|includingRegex|excludingRegex",
            "expression": "..."}. Multiple filters are ANDed.
        search_type: web (default), image, video, news, discover, googleNews.
    """
    if dimensions:
        bad = set(dimensions) - DIMENSIONS
        if bad:
            raise ValueError(f"Unknown dimensions: {sorted(bad)}. Allowed: {sorted(DIMENSIONS)}")
    if not start_date or not end_date:
        start_date, end_date = _default_range()
    body: dict[str, Any] = {
        "startDate": start_date,
        "endDate": end_date,
        "rowLimit": max(1, min(row_limit, 25000)),
        "startRow": max(0, start_row),
        "type": search_type,
        "dataState": "final",
    }
    if dimensions:
        body["dimensions"] = dimensions
    fg = _build_filters(filters)
    if fg:
        body["dimensionFilterGroups"] = fg
    rows = _query(site, body)
    totals = {
        "clicks": sum(r["clicks"] for r in rows),
        "impressions": sum(r["impressions"] for r in rows),
    }
    return {"site": site, "startDate": start_date, "endDate": end_date,
            "rowCount": len(rows), "totals": totals, "rows": rows}


@mcp.tool()
def compare_periods(
    site: str,
    current_start: str,
    current_end: str,
    previous_start: str,
    previous_end: str,
    dimension: str | None = None,
    row_limit: int = 50,
    filters: list[dict[str, str]] | None = None,
    search_type: str = "web",
) -> dict[str, Any]:
    """Compare two date ranges side by side with deltas.

    With no dimension, returns site-wide totals for both periods. With a
    dimension (query, page, country, device), returns the top rows by current
    clicks with previous-period values and deltas; rows that only exist in one
    period are included with zeros for the other.
    """
    if dimension and dimension not in DIMENSIONS:
        raise ValueError(f"Unknown dimension {dimension!r}. Allowed: {sorted(DIMENSIONS)}")

    def run(s: str, e: str) -> list[dict[str, Any]]:
        body: dict[str, Any] = {
            "startDate": s, "endDate": e, "type": search_type, "dataState": "final",
            "rowLimit": max(row_limit * 4, 200) if dimension else 1,
        }
        if dimension:
            body["dimensions"] = [dimension]
        fg = _build_filters(filters)
        if fg:
            body["dimensionFilterGroups"] = fg
        return _query(site, body)

    cur, prev = run(current_start, current_end), run(previous_start, previous_end)

    def agg(rows: list[dict[str, Any]]) -> dict[str, float]:
        clicks = sum(r["clicks"] for r in rows)
        imps = sum(r["impressions"] for r in rows)
        pos = (sum(r["position"] * r["impressions"] for r in rows) / imps) if imps else 0.0
        return {"clicks": clicks, "impressions": imps,
                "ctr": round(clicks / imps, 4) if imps else 0.0, "position": round(pos, 2)}

    def delta(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
        out = {}
        for k in ("clicks", "impressions", "ctr", "position"):
            out[k] = round(a[k] - b[k], 4)
        out["clicks_pct"] = round((a["clicks"] - b["clicks"]) / b["clicks"] * 100, 1) if b["clicks"] else None
        return out

    result: dict[str, Any] = {
        "site": site,
        "current": {"startDate": current_start, "endDate": current_end, **agg(cur)},
        "previous": {"startDate": previous_start, "endDate": previous_end, **agg(prev)},
    }
    result["delta"] = delta(result["current"], result["previous"])

    if dimension:
        prev_by_key = {r[dimension]: r for r in prev}
        cur_by_key = {r[dimension]: r for r in cur}
        keys = sorted(set(cur_by_key) | set(prev_by_key),
                      key=lambda k: cur_by_key.get(k, {}).get("clicks", 0), reverse=True)[:row_limit]
        zero = {"clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0}
        rows = []
        for k in keys:
            c = cur_by_key.get(k, zero)
            p = prev_by_key.get(k, zero)
            rows.append({dimension: k,
                         "current": {x: c[x] for x in zero},
                         "previous": {x: p[x] for x in zero},
                         "delta": delta({x: c[x] for x in zero}, {x: p[x] for x in zero})})
        result["dimension"] = dimension
        result["rows"] = rows
    return result


@mcp.tool()
def list_sitemaps(site: str) -> list[dict[str, Any]]:
    """List submitted sitemaps for a property with status, last download,
    errors/warnings and indexed URL counts."""
    resp = _service().sitemaps().list(siteUrl=site).execute()
    out = []
    for s in resp.get("sitemap", []):
        out.append({
            "path": s.get("path"),
            "lastSubmitted": s.get("lastSubmitted"),
            "lastDownloaded": s.get("lastDownloaded"),
            "isPending": s.get("isPending"),
            "errors": s.get("errors", 0),
            "warnings": s.get("warnings", 0),
            "contents": s.get("contents", []),
        })
    return out


@mcp.tool()
def inspect_url(site: str, url: str, language: str = "en-US") -> dict[str, Any]:
    """Run URL Inspection for a page: index status, coverage verdict, canonical
    (Google vs user), last crawl, robots/indexing state, mobile and rich-result
    verdicts. Quota: 2000 calls/day per property. Requires Owner or Full access."""
    body = {"inspectionUrl": url, "siteUrl": site, "languageCode": language}
    resp = _service().urlInspection().index().inspect(body=body).execute()
    r = resp.get("inspectionResult", {})
    idx = r.get("indexStatusResult", {})
    return {
        "url": url,
        "inspectionResultLink": r.get("inspectionResultLink"),
        "verdict": idx.get("verdict"),
        "coverageState": idx.get("coverageState"),
        "indexingState": idx.get("indexingState"),
        "robotsTxtState": idx.get("robotsTxtState"),
        "pageFetchState": idx.get("pageFetchState"),
        "lastCrawlTime": idx.get("lastCrawlTime"),
        "crawledAs": idx.get("crawledAs"),
        "googleCanonical": idx.get("googleCanonical"),
        "userCanonical": idx.get("userCanonical"),
        "referringUrls": idx.get("referringUrls", []),
        "sitemap": idx.get("sitemap", []),
        "mobileUsability": r.get("mobileUsabilityResult", {}).get("verdict"),
        "richResults": r.get("richResultsResult", {}).get("verdict"),
    }


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
