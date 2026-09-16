# Polvenn MCP Server

A local-first [MCP](https://modelcontextprotocol.io) server for tracking beer releases on [Vinmonopolet](https://www.vinmonopolet.no) and an external release-feed API backed by your own collector/database.

npm package: `@henrikogard/polvenn-mcp-server`
CLI command: `polvenn-mcp-server`

It is designed to run as a local stdio MCP server:

- no web app
- no telemetry
- no cloud sync
- data stays on your machine in SQLite

## What It Does

Polvenn exposes 13 MCP tools, 2 MCP resources plus 2 resource templates, and 3 MCP prompts. Every tool declares its structured output schema, so strict MCP clients get a contractually valid `structuredContent` payload alongside human-readable text.

| Tool | Description | Writes data? |
|------|-------------|--------------|
| `polvenn_search_new_beers` | Search Vinmonopolet's current `Nyheter` listing and/or your external release feed, with optional `Kommende nyheter`, `releaseDate`, and `storeId` filters | No |
| `polvenn_search_upcoming_beers` | Search Vinmonopolet's "Kommende nyheter" listing for upcoming beer releases | No |
| `polvenn_search_new_beers_near_store` | Search current `Nyheter` available in one store, using your configured home store or nearest configured location by default | No |
| `polvenn_search_products` | Search the full catalogue by name, article number, or EAN-13 barcode — works without an API key via vinmonopolet.no, with optional name/price sorting | No |
| `polvenn_get_product` | Get full details for one product by article number: price, ABV, volume, availability, tasting notes, and image URLs | No |
| `polvenn_check_store_stock` | Check stock for a beer at a Vinmonopolet store, using the official API when possible and Vinmonopolet's web stock locator as fallback | No |
| `polvenn_find_nearby_stores` | Find the closest Vinmonopolet stores to a coordinate, with today's opening hours | No |
| `polvenn_find_stores_with_stock` | Find stores that currently have a product in stock, ordered by distance (keyless, via the web stock locator) | No |
| `polvenn_get_changed_products` | List products changed since a date via the official API's `changedSince` filter, with a stored sync marker | Yes (sync marker) |
| `polvenn_get_facets` | List available search filters (categories, countries, price ranges…) with result counts, from vinmonopolet.no | No |
| `polvenn_watchlist` | Add, remove, list, and check watch rules — text, ABV/price bounds, and per-article stock watches | Yes |
| `polvenn_configure` | Store API keys, home store, and home coordinates locally | Yes |
| `polvenn_validate_config` | Validate current config and probe upstream capabilities | No |

### Resources

| URI | Description |
|-----|-------------|
| `polvenn://watchlist` | Your saved watchlist rules as JSON (subscribable — updated when rules change) |
| `polvenn://config` | Current configuration as JSON (API key masked) |
| `polvenn://product/{articleNumber}` | Resource template — one product as JSON, with image URL |
| `polvenn://store/{storeId}` | Resource template — one store as JSON, with today's opening hours |

### Prompts

| Prompt | Description |
|--------|-------------|
| `polvenn_check_watchlist` | Check the watchlist and summarize new matches |
| `polvenn_whats_new` | Find new releases, optionally filtered by `style` and `storeId` |
| `polvenn_stock_check` | Check stock for an `articleNumber` at a store |

Typical use cases:

- “Show me new imperial stouts from the last 30 days”
- “Is article `20162402` in stock near Stavanger?”
- “Find the nearest Vinmonopolet stores to my home”
- “Alert me when Amundsen, Lervig, or pastry stouts show up”

If the official Vinmonopolet stock endpoint is not available, Polvenn falls back to Vinmonopolet's own web stock locator for store-level counts when possible. If neither source can verify the store, Polvenn reports store-level stock as unknown instead of incorrectly reporting zero stock or inferring "bestillingsutvalget" as a store-stock answer.

For `polvenn_search_new_beers`, the `since` filter is best-effort: Polvenn prefers external release dates when available, and otherwise falls back to Vinmonopolet's `lastChanged` timestamp.
If you pass `storeId`, only Vinmonopolet-backed results that are available in that store are included.

## Architecture

```text
Any MCP client
(Codex, Claude Desktop, Inspector, others)
        │
        │ stdio
        ▼
polvenn-mcp-server
├── tools
├── zod schemas
├── Vinmonopolet service
├── External release feed client
└── SQLite storage via sql.js
        │
        ▼
~/.polvenn/polvenn.db
```

Project structure:

```text
src/
├── index.ts              # MCP server entry point
├── constants.ts          # URLs, defaults, retry/timeout settings
├── types.ts              # Domain types
├── sql.js.d.ts           # Local sql.js typings
├── tools/
│   ├── index.ts          # MCP tool registration and handlers
│   └── server.test.ts    # End-to-end tests over the SDK in-memory transport
├── resources/
│   └── index.ts          # polvenn://watchlist and polvenn://config resources
├── prompts/
│   └── index.ts          # MCP prompts
├── schemas/
│   ├── tools.ts          # Zod input schemas
│   └── output.ts         # Zod output schemas (structured content contracts)
├── services/
│   ├── release-feed.ts   # External release feed client
│   ├── vinmonopolet.ts   # Vinmonopolet API client
│   └── watchlist.ts      # Watchlist matching logic
├── utils/
│   ├── concurrency.ts    # Bounded-concurrency async mapping
│   ├── geo.ts
│   └── http.ts           # Fetch with retry, backoff, and timeouts
├── db/
│   ├── database.ts       # SQLite persistence, migrations, config
│   └── migrations.test.ts
└── test/
    └── setup.ts          # Per-file throwaway data dir for tests
```

## Setup

### Prerequisites

- Node.js 18 or newer
- A Vinmonopolet API key from [api.vinmonopolet.no](https://api.vinmonopolet.no)
### Install

```bash
npm install
npx tsc --noEmit
npm run build
```

Published npm package:

```bash
npm install -g @henrikogard/polvenn-mcp-server
```

### Run

```bash
npm start
```

This starts the MCP server on stdio, which is what local desktop/CLI MCP clients expect.

## Using It From MCP Clients

### Generic stdio client setup

If your MCP client supports local stdio servers, point it at:

```text
command: node
args: ["/absolute/path/to/polvenn-mcp-server/dist/index.js"]
```

If you installed the package globally from npm, you can also point the client directly at the CLI:

```text
command: polvenn-mcp-server
args: []
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "polvenn": {
      "command": "node",
      "args": ["/absolute/path/to/polvenn-mcp-server/dist/index.js"]
    }
  }
}
```

After restarting Claude Desktop, configure your own collector from chat:

```text
Configure polvenn with release feed URL https://releases.example.com.
```

### Codex

Codex supports MCP server definitions in `~/.codex/config.toml`. Add:

```toml
[mcp_servers.polvenn]
command = "node"
args = ["/absolute/path/to/polvenn-mcp-server/dist/index.js"]
```

Restart Codex after saving the config.

Then configure your own collector from a Codex chat:

```text
Configure polvenn with release feed URL https://releases.example.com.
```

### ChatGPT

As of April 7, 2026, ChatGPT apps/custom MCP integrations use remote MCP servers over SSE or streaming HTTP, not local stdio servers.

That means this repo does not plug directly into ChatGPT in its current form.

To use Polvenn with ChatGPT, you would need to:

1. Wrap or rebuild it as a remote MCP server.
2. Expose it over HTTPS using SSE or streaming HTTP.
3. Add it in ChatGPT developer mode as an app/custom MCP integration.

In other words:

- Codex and Claude Desktop can use this project directly as-is.
- ChatGPT needs a remote deployment, not this local stdio process.

## First-Time Configuration

Once connected from an MCP client, configure the local server with your keys and defaults.

### External collector setup

Polvenn expects an external release collector that exposes:

```text
GET /releases/latest
```

You can run your own collector from GitHub here:

- [henrikogaard/polvenn-release-collector](https://github.com/henrikogaard/polvenn-release-collector)

Quick setup:

1. Clone the collector repo.
2. Run `npm install`.
3. Run `npm run build`.
4. Copy `polvenn-release-collector.config.example.json` to `polvenn-release-collector.config.json`.
5. Start it with `npm start`.
6. Verify `http://127.0.0.1:4100/health`.
7. Verify `http://127.0.0.1:4100/releases/latest?limit=3`.

If you want to expose it publicly on a VPS, follow the deployment guide in the collector repo:

- [polvenn-release-collector/deploy/DEPLOY.md](https://github.com/henrikogaard/polvenn-release-collector/blob/main/deploy/DEPLOY.md)

Once your collector is running, choose your own feed URL, for example:

```text
releaseFeedUrl = http://127.0.0.1:4100
```

or:

```text
releaseFeedUrl = https://releases.example.com
```

That means the local MCP server will read from:

```text
https://releases.example.com/releases/latest?limit=...
```

Recommended order:

1. Set up your own `polvenn-release-collector`.
2. Verify its `/health` endpoint.
3. Verify its `/releases/latest?limit=3` endpoint.
4. Start `polvenn-mcp-server` locally in Codex or Claude Desktop.
5. Configure Polvenn with the hosted `releaseFeedUrl`.
6. Validate the configuration from the MCP client.

Example prompts:

```text
Configure polvenn with release feed URL https://releases.example.com.
```

```text
Configure polvenn with Vinmonopolet API key <key>.
Set home location to Stavanger (58.97, 5.73).
Set home store to 170.
```

```text
Validate my Polvenn configuration and tell me which integrations are working.
```

## Example Prompts

These work well in Codex, Claude Desktop, or another MCP client:

```text
Search for new stouts from the last 30 days.
```

```text
Search for new beers available in store 116.
```

```text
Search for new beers from the 1. april 2026 release.
```

```text
Search for new beers and include upcoming Vinmonopolet web releases.
```

```text
Show upcoming beers from Vinmonopolet.
```

```text
Show upcoming sour beers from Vinmonopolet.
```

```text
Show new sour beers near my store.
```

```text
Check whether article 20162402 is in stock at store 170.
```

```text
Find the 5 closest Vinmonopolet stores to 58.97, 5.73.
```

```text
Add a watchlist rule for brewery Lervig.
```

```text
Check my watchlist against the latest release in my external feed.
```

## Watchlist Rules

The watchlist supports eight rule types:

| Type | Matches against | Example |
|------|-----------------|---------|
| `brewery` | Producer name | `Lervig` |
| `style` | Beer style | `Imperial Stout` |
| `series` | Beer name | `Racketeers` |
| `keyword` | Beer name and producer | `barrel aged` |
| `country` | Country of origin | `Norge` |
| `abv` | ABV bounds (`minValue`/`maxValue`) | `abv 8–12` |
| `price` | Price bounds (`minValue`/`maxValue`), best-effort | `price <= 200` |
| `stock` | One article number's stock at your home store | `20162402` |

Text rules match by substring. `abv` and `price` rules take numeric bounds instead of `value` (which is derived, e.g. `abv >= 10`). Price rules are best-effort: prices are looked up via Vinmonopolet during a check, and beers whose price cannot be resolved are reported as not evaluated rather than silently skipped or guessed. `stock` rules are checked against live store stock at your home store during `check`; a beer that sells out and comes back is reported as new again.

## Storage

All local state lives in:

```text
~/.polvenn/polvenn.db
```

Override the data directory with:

```bash
POLVENN_DATA_DIR=/some/path
```

Stored data includes:

- config values
- watchlist rules
- cached Vinmonopolet product lookups

API keys are stored locally and only sent to their respective upstream APIs.

## Packaging

The package metadata is set up for npm publishing:

- npm package name: `@henrikogard/polvenn-mcp-server`
- installable CLI entry: `polvenn-mcp-server`
- packaged files limited to `dist/`, `README.md`, and `LICENSE`
- `prepack` builds the TypeScript output before publishing

## Data Sources

### Vinmonopolet API

- Base: `https://apis.vinmonopolet.no`
- Auth: `Ocp-Apim-Subscription-Key`
- Used for: products, stores, stock
- Product lookups fall back to the public product page on `vinmonopolet.no` when the API returns sparse article data
- Docs: [api.vinmonopolet.no](https://api.vinmonopolet.no)

### Vinmonopolet website (undocumented, no auth)

- Search with free text, facets, and name/price sorting: `www.vinmonopolet.no/vmpws/v2/vmp/products/search`
- Barcode lookup: `www.vinmonopolet.no/vmpws/v2/vmp/products/barCodeSearch/{ean}`
- Store stock locator (by proximity, paginated): `www.vinmonopolet.no/vmpws/v2/vmp/products/{id}/stock`
- Facet tree: `www.vinmonopolet.no/api/search?fields=FULL`
- Product images (best-effort; placeholder for missing photos): `bilder.vinmonopolet.no/cache/{w}x{h}-0/{article}-1.jpg` — see the [product images post](https://api.vinmonopolet.no/blog/product-images); CDN use is covered by the API terms of service

These endpoints are undocumented and can change without notice; responses are validated leniently and malformed entries are dropped with a warning rather than failing the call.

### External Release Feed

- Base: your configured `releaseFeedUrl`
- Endpoint used by MCP: `GET /releases/latest?limit=N`
- Expected response shape:

```json
{
  "releases": [
    {
      "id": "2026-04-01-main",
      "title": "April 2026 main release",
      "source": "vinmonopolet-monthly",
      "publishedAt": "2026-04-01T08:00:00Z",
      "url": "https://example.com/release/2026-04-01-main",
      "items": [
        {
          "country": "Norge",
          "articleNumber": "20162402",
          "producer": "Amundsen Bryggeri",
          "name": "Example Beer",
          "style": "Imperial Stout",
          "abv": 12,
          "releaseDate": "1. april 2026"
        }
      ]
    }
  ]
}
```

## Development

```bash
npm run dev         # tsc --watch
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm test            # vitest run (tests never touch your real ~/.polvenn data)
npm run build
npm run smoke       # spawns dist/index.js and verifies the MCP handshake, tools, resources, prompts
npm run probe       # opt-in live probe of every upstream source; records fixtures/live/ (gitignored)
```

CI runs lint, typecheck, tests, build, and the smoke script on Node 20/22/24 via GitHub Actions.

### Test With MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `sql.js` | SQLite in pure JavaScript |
| `cheerio` | HTML parsing |
| `zod` (v4) | Input and output validation |
| `typescript` | Build tooling |
| `vitest` | Test runner |
| `@biomejs/biome` | Linting and formatting |

## Notes

- The server is intentionally local-first and stdio-first.
- Stock access may depend on the Vinmonopolet subscription tier you have.
- The official API's product responses have been slimmed down upstream (basic + lastChanged only); Polvenn enriches them from product pages and prefers the richer website search.
- Vinmonopolet removed the "Kommende nyheter" listing from vinmonopolet.no; `polvenn_search_upcoming_beers` reports that honestly instead of returning empty results. The other website endpoints used here (search, barcode, stock locator, facet tree via search) were verified live in September 2026.
- ChatGPT support requires a remote MCP variant of this server.

## License

MIT
