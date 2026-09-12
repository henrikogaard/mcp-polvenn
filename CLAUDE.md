# CLAUDE.md — Polvenn MCP Server

## Overview

Polvenn is a local-first MCP server for:

- searching beer releases from Vinmonopolet
- searching the full Vinmonopolet product catalogue
- reading external release-feed data
- finding nearby Vinmonopolet stores
- checking store stock
- maintaining a local beer watchlist

Package name: `@henrikogard/polvenn-mcp-server`
CLI command: `polvenn-mcp-server`

## Project layout

```text
src/
├── index.ts
├── constants.ts
├── types.ts
├── sql.js.d.ts
├── tools/
│   ├── index.ts
│   └── server.test.ts
├── resources/
│   └── index.ts
├── prompts/
│   └── index.ts
├── schemas/
│   ├── tools.ts          # Zod input schemas
│   └── output.ts         # Zod output schemas (structured content contracts)
├── services/
│   ├── release-feed.ts
│   ├── vinmonopolet.ts
│   └── watchlist.ts
├── utils/
│   ├── concurrency.ts
│   ├── geo.ts
│   └── http.ts
├── db/
│   ├── database.ts
│   └── migrations.test.ts
└── test/
    └── setup.ts          # Throwaway data dir per test file
```

## Main tools

- `polvenn_search_new_beers`
- `polvenn_search_upcoming_beers`
- `polvenn_search_new_beers_near_store`
- `polvenn_search_products`
- `polvenn_get_product`
- `polvenn_check_store_stock`
- `polvenn_find_nearby_stores`
- `polvenn_watchlist`
- `polvenn_configure`
- `polvenn_validate_config`

Also exposes resources `polvenn://watchlist` and `polvenn://config`, plus three prompts (`polvenn_check_watchlist`, `polvenn_whats_new`, `polvenn_stock_check`).

## Important notes

- stdio transport only
- SQLite database via `sql.js`, with `PRAGMA user_version`-based migrations in `src/db/database.ts`
- every tool declares a Zod `outputSchema`; handlers construct structured content via `schema.parse`
- local data path defaults to `~/.polvenn/polvenn.db` (override with `POLVENN_DATA_DIR`)
- external release data comes from your configured `releaseFeedUrl`
- stock access may be limited if the user only has Vinmonopolet `Open` access
- HTTP requests have retry with backoff and a 15s per-attempt timeout
- watchlist rules: `brewery`, `style`, `series`, `keyword`, `country` (text) and `abv`, `price` (numeric bounds; price is best-effort via Vinmonopolet)

## Useful commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx @modelcontextprotocol/inspector node dist/index.js
```

## Example configuration prompt

```text
Configure polvenn with Vinmonopolet API key <key>. Set home location to Stavanger (58.97, 5.73). Set home store to 170.
```

## Example validation prompt

```text
Validate my Polvenn configuration and tell me which integrations are working.
```
