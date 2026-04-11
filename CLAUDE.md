# CLAUDE.md — Polvenn MCP Server

## Overview

Polvenn is a local-first MCP server for:

- searching beer releases from Vinmonopolet
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
│   └── index.ts
├── schemas/
│   └── tools.ts
├── services/
│   ├── release-feed.ts
│   ├── vinmonopolet.ts
│   └── watchlist.ts
├── utils/
│   ├── geo.ts
│   └── http.ts
└── db/
    └── database.ts
```

## Main tools

- `polvenn_search_new_beers`
- `polvenn_check_store_stock`
- `polvenn_find_nearby_stores`
- `polvenn_watchlist`
- `polvenn_configure`
- `polvenn_validate_config`

## Important notes

- stdio transport only
- SQLite database via `sql.js`
- local data path defaults to `~/.polvenn/polvenn.db`
- external release data comes from your configured `releaseFeedUrl`
- stock access may be limited if the user only has Vinmonopolet `Open` access

## Useful commands

```bash
npx tsc --noEmit
npm run build
npm test
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
