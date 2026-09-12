# gsc-mcp — Google Search Console MCP server

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and any other MCP client access to Google Search Console: search analytics, period comparisons, sitemaps and URL inspection.

Built and used daily by [Walma AI](https://walma.ai) to run our own SEO through Claude Code. There is a longer write-up in our guide: [Google Search Console MCP](https://walma.ai/en/guides/mcp/google-search-console-mcp).

**Why service-account auth:** no personal Google login on the machine that runs the agent, a key you can rotate and revoke, and read-only scope. Right for teams and for servers.

## Tools

| Tool | What it does |
|---|---|
| `list_sites` | Properties the service account can see, with permission level |
| `search_analytics` | Clicks, impressions, CTR and position by date, query, page, country, device or search appearance, with filters and pagination |
| `compare_periods` | Two date ranges side by side with deltas, site-wide or per dimension |
| `list_sitemaps` | Submitted sitemaps with status, errors and indexed counts |
| `inspect_url` | URL Inspection: index status, canonical, last crawl, mobile and rich-result verdicts |

Everything is read-only (`webmasters.readonly` scope). The server cannot change anything in Search Console.

## Setup

### 1. Create a service account and key

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project.
2. Enable the **Google Search Console API** (`searchconsole.googleapis.com`).
3. IAM & Admin → Service accounts → Create. No project roles are needed.
4. Keys → Add key → JSON. Save the file somewhere outside any repository, for example `~/.config/gcloud/gsc-service-account.json`.

### 2. Give the service account access in Search Console

In [Search Console](https://search.google.com/search-console), for each property: Settings → Users and permissions → Add user → the service account's e-mail (`...@...iam.gserviceaccount.com`).

- **Full** is enough for `search_analytics`, `compare_periods` and `list_sitemaps`.
- `inspect_url` needs **Owner** or **Full** depending on the property type.

### 3. Install

With [uv](https://docs.astral.sh/uv/) (no clone needed):

```bash
uvx --from git+https://github.com/Walma-Labs/gsc-mcp gsc-mcp
```

Or with pipx:

```bash
pipx install git+https://github.com/Walma-Labs/gsc-mcp
```

Or from a clone:

```bash
git clone https://github.com/Walma-Labs/gsc-mcp && cd gsc-mcp
python -m venv .venv && .venv/bin/pip install -e .
```

### 4. Add it to your client

The server reads one environment variable, `GSC_SERVICE_ACCOUNT_FILE`, the path to the JSON key.

**Claude Code**

```bash
claude mcp add --transport stdio gsc \
  -e GSC_SERVICE_ACCOUNT_FILE=~/.config/gcloud/gsc-service-account.json \
  -- uvx --from git+https://github.com/Walma-Labs/gsc-mcp gsc-mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "gsc": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/Walma-Labs/gsc-mcp", "gsc-mcp"],
      "env": { "GSC_SERVICE_ACCOUNT_FILE": "/Users/you/.config/gcloud/gsc-service-account.json" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gsc": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/Walma-Labs/gsc-mcp", "gsc-mcp"],
      "env": { "GSC_SERVICE_ACCOUNT_FILE": "/Users/you/.config/gcloud/gsc-service-account.json" }
    }
  }
}
```

Use absolute paths in the desktop clients; they do not expand `~` or inherit your shell's `PATH`.

## Using it

Properties are addressed the way the API addresses them: `sc-domain:example.com` for domain properties, `https://example.com/` for URL-prefix properties. Ask the agent to run `list_sites` first if unsure.

Things it is good at:

- "Which queries drive the most clicks to `/pricing`, and what is our average position for each?"
- "Compare the last 28 days with the previous 28. Which pages lost the most clicks, and which queries on those pages dropped?"
- "Queries with more than 500 impressions where we rank between 11 and 20."
- "Is `/guides/mcp` indexed, and what does Google consider the canonical?"
- "List sitemaps and any with errors."

Two things to tell the agent: Search Analytics data lags about two days (the server defaults to a range ending two days ago), and Google anonymises long-tail queries, so totals by query will not match totals by page.

## Running it for a team

The key file grants read access to all your search data. On a laptop it is one lost machine away from a leak, and calls are not attributable to a person. For a team, put the server behind a gateway that holds the key centrally, exposes the server to approved users and logs each query. That is how we run it at Walma, behind [Walma AI Hub](https://walma.ai/en/ai-hub) inside our own EU tenant, next to Google Ads, GA4 and Ahrefs.

## Development

```bash
.venv/bin/pip install -e .
GSC_SERVICE_ACCOUNT_FILE=~/.config/gcloud/gsc-service-account.json .venv/bin/gsc-mcp
```

The server speaks MCP over stdio. Test it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector .venv/bin/gsc-mcp
```

## License

MIT. Copyright (c) 2026 Walma AI AB.
