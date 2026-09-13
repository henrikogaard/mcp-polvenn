# AGENTS.md — Polvenn MCP Server

## What is this?

A local-first MCP (Model Context Protocol) server for tracking beer releases on Vinmonopolet and an external release-feed API backed by your own collector/database.

**Package**: `@henrikogard/polvenn-mcp-server`  
**CLI**: `polvenn-mcp-server`  
**Author**: Henrik  
**Location**: `/Users/henrik/Dev/Repos/mcp-polvenn`

---

## Current scope

This project currently focuses on:

- Vinmonopolet product search (beer releases and the full catalogue)
- Vinmonopolet store discovery
- Vinmonopolet stock checks
- external release-feed lookups
- local watchlist rules and incremental watchlist checks
- local configuration validation

---

## Architecture

```text
polvenn-mcp-server/
├── src/
│   ├── index.ts              # Entry point — McpServer + stdio transport
│   ├── constants.ts          # API base URLs, defaults, retry/timeout settings
│   ├── types.ts              # Domain interfaces
│   ├── sql.js.d.ts           # Type declarations for sql.js
│   ├── tools/
│   │   ├── index.ts          # MCP tool registrations + handlers
│   │   └── server.test.ts    # End-to-end tests (in-memory MCP transport)
│   ├── resources/
│   │   └── index.ts          # resources + polvenn://product and polvenn://store templates
│   ├── prompts/
│   │   └── index.ts          # MCP prompts
│   ├── schemas/
│   │   ├── tools.ts          # Zod input schemas
│   │   └── output.ts         # Zod output schemas (structured content contracts)
│   ├── services/
│   │   ├── release-feed.ts   # External release feed client
│   │   ├── vinmonopolet.ts   # Vinmonopolet API client
│   │   └── watchlist.ts      # Watchlist matching logic
│   ├── utils/
│   │   ├── concurrency.ts    # Bounded-concurrency async mapping
│   │   ├── geo.ts            # Distance calculations
│   │   └── http.ts           # Fetch retry/backoff + per-attempt timeouts
│   └── db/
│       ├── database.ts       # SQLite via sql.js — watchlist, cache, config, migrations
│       └── migrations.test.ts
├── scripts/
│   └── smoke.mjs             # Stdio MCP handshake smoke test
├── .github/workflows/ci.yml  # lint + typecheck + test + build + smoke (Node 20/22/24)
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── .gitignore
├── README.md
└── AGENTS.md
```

---

## Key decisions

- **Transport**: stdio only
- **Database**: SQLite via `sql.js`
- **Storage path**: `~/.polvenn/polvenn.db`
- **Override path**: `POLVENN_DATA_DIR`
- **No telemetry**
- **Tool prefix**: `polvenn_`
- **SDK**: `@modelcontextprotocol/sdk` with `server.registerTool()`

---

## Data sources

### 1. Vinmonopolet API

- Base: `https://apis.vinmonopolet.no`
- Auth: `Ocp-Apim-Subscription-Key`
- Used endpoints:
  - `GET /products/v0/details-normal`
  - `GET /stores/v0/details`
  - `GET /products/v0/accumulated-stock`
- Undocumented website endpoints on `https://www.vinmonopolet.no` (no auth):
  - `GET /vmpws/v2/vmp/products/search` ("Nyheter" / "Kommende nyheter" facets)
  - `GET /vmpws/v2/vmp/stores/{id}`
  - `GET /vmpws/v2/vmp/products/{id}/stock` (stock locator fallback)
  - product pages `/p/{id}` (embedded JSON payload, parsed with cheerio)
- Notes:
  - stock access may require more than the free `Open` subscription
  - product and store access should work with `Open`
  - upstream responses are validated leniently (zod loose schemas); malformed entries are dropped with a warning instead of failing the call

### 2. External release feed

- Base: configured via `releaseFeedUrl`
- Endpoint used by MCP: `GET /releases/latest?limit=N`
- Access: JSON over HTTP
- Bridge to Vinmonopolet: article numbers map directly to product IDs

---

## Tools

Current tool set (every tool declares an `outputSchema`; structured content is validated against it):

| Tool | Description |
|------|-------------|
| `polvenn_search_new_beers` | Find new releases from Vinmonopolet and/or the external release feed |
| `polvenn_search_upcoming_beers` | Find upcoming releases from Vinmonopolet's "Kommende nyheter" listing |
| `polvenn_search_new_beers_near_store` | Find new releases available in one store |
| `polvenn_search_products` | Search the full catalogue by name, article number, or EAN-13 barcode (keyless via vinmonopolet.no, with sort support) |
| `polvenn_get_product` | Get full details for one article number (incl. image URLs) |
| `polvenn_check_store_stock` | Check stock for an article number at a store |
| `polvenn_find_nearby_stores` | Find nearby Vinmonopolet stores by coordinates (incl. today's opening hours) |
| `polvenn_find_stores_with_stock` | Find stores with a product in stock, ordered by distance (keyless) |
| `polvenn_get_changed_products` | List products changed since a date via `changedSince` (official API) |
| `polvenn_get_facets` | List available search filters from vinmonopolet.no (keyless) |
| `polvenn_watchlist` | Add, remove, list, and check watch rules |
| `polvenn_configure` | Store API key, home store, and home location |
| `polvenn_validate_config` | Validate config and probe live capabilities |

### Resources and prompts

- Resources: `polvenn://watchlist` (subscribable, updated on add/remove) and `polvenn://config` (API key masked)
- Resource templates: `polvenn://product/{articleNumber}` and `polvenn://store/{storeId}`
- Prompts: `polvenn_check_watchlist`, `polvenn_whats_new`, `polvenn_stock_check`

### Watchlist rules

The watchlist supports:

- text rules: `brewery`, `style`, `series`, `keyword`, `country`
- numeric bounds rules: `abv`, `price` (take `minValue`/`maxValue`; `value` is derived)
- stock rules: `stock` (value = article number; checked against live stock at the home store)

`check` compares the latest external release against all saved rules and tracks which matches are new since the previous check for that release. Price rules are best-effort: prices are enriched from Vinmonopolet during checks, and beers with unknown prices are reported as not evaluated. Stock rules use a separate checkpoint that only remembers currently-in-stock articles, so sell-out-and-return cycles are reported as new again.

---

## Current status

The project builds and tests cleanly.

Useful validation commands:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run smoke
npm run probe   # opt-in live probe of upstream sources
```

---

## Known limitations

1. The external release feed must expose the expected JSON shape for MCP lookups to work.
2. Vinmonopolet stock access may fail for users who only have `Open` subscription access.
3. The official API's details-normal responses have been slimmed down upstream to `basic` + `lastChanged` only (no classification/prices/availability). Polvenn fills the gap from cached/scraped product pages (enrichSlimProducts) and prefers the richer website search; verify with `npm run probe` when the API changes again.
4. Vinmonopolet removed the "Kommende nyheter" listing from vinmonopolet.no in a site rebuild. `polvenn_search_upcoming_beers` reports this honestly as unavailable; the tool and its plumbing are kept so a future relaunch works again. `polvenn_get_facets` uses the search response's facet tree because the old dedicated facets endpoint is also gone.

---

## Conventions

- Dates: ISO 8601 `yyyy-MM-dd`
- Tool names: `polvenn_` prefix, snake_case
- Zod schemas: `z.strictObject()` for inputs; output schemas in `src/schemas/output.ts`
- Errors: `{ isError: true, content: [{ type: "text", text: "..." }] }` (no structured content on errors)
- Logging: `console.error()` only
- Avoid `any`; prefer `unknown` and type guards
- Database schema changes go through the `PRAGMA user_version` migration runner in `src/db/database.ts`
- Tests never touch the real data dir (`src/test/setup.ts` sets a throwaway `POLVENN_DATA_DIR`)

---

## Development setup

```bash
npm install
npm run typecheck
npm run build
npm start
```

### Codex integration

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.polvenn]
command = "node"
args = ["/Users/henrik/Dev/Repos/mcp-polvenn/dist/index.js"]
```

### First-time configuration

Example:

```text
Configure polvenn with release feed URL https://releases.example.com. Set home location to Stavanger (58.97, 5.73). Set home store to 170.
```

### Validation

```text
Validate my Polvenn configuration and tell me which integrations are working.
```

---

## Links

- Vinmonopolet API portal: https://api.vinmonopolet.no
- Vinmonopolet datadeling: https://www.vinmonopolet.no/om-oss/presse/datadeling
- MCP specification: https://modelcontextprotocol.io
- Reference wrapper: https://github.com/rexxars/vinmonopolet
