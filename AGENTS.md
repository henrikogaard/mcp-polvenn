# AGENTS.md — Polvenn MCP Server

## What is this?

A local-first MCP (Model Context Protocol) server for tracking beer releases on Vinmonopolet and an external release-feed API backed by your own collector/database.

**Package**: `@henrikogard/polvenn-mcp-server`  
**CLI**: `polvenn-mcp-server`  
**Author**: Henrik  
**Location**: `/Users/henrik/Repos/mcp-polvenn`

---

## Current scope

This project currently focuses on:

- Vinmonopolet product search
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
│   ├── constants.ts          # API base URLs, defaults, retry settings
│   ├── types.ts              # Domain interfaces
│   ├── sql.js.d.ts           # Type declarations for sql.js
│   ├── tools/
│   │   └── index.ts          # MCP tool registrations + handlers
│   ├── schemas/
│   │   └── tools.ts          # Zod input schemas
│   ├── services/
│   │   ├── release-feed.ts   # External release feed client
│   │   ├── vinmonopolet.ts   # Vinmonopolet API client
│   │   └── watchlist.ts      # Watchlist matching logic
│   ├── utils/
│   │   ├── geo.ts            # Distance calculations
│   │   └── http.ts           # Fetch retry/backoff
│   └── db/
│       └── database.ts       # SQLite via sql.js — watchlist, cache, config
├── package.json
├── tsconfig.json
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

- Base: `https://api.vinmonopolet.no`
- Auth: `Ocp-Apim-Subscription-Key`
- Used endpoints:
  - `GET /products/v0/details-normal`
  - `GET /stores/v0/details`
  - `GET /products/v0/accumulated-stock`
- Notes:
  - stock access may require more than the free `Open` subscription
  - product and store access should work with `Open`

### 2. External release feed

- Base: configured via `releaseFeedUrl`
- Endpoint used by MCP: `GET /releases/latest?limit=N`
- Access: JSON over HTTP
- Bridge to Vinmonopolet: article numbers map directly to product IDs

---

## Tools

Current tool set:

| Tool | Description |
|------|-------------|
| `polvenn_search_new_beers` | Find new releases from Vinmonopolet and/or the external release feed |
| `polvenn_check_store_stock` | Check stock for an article number at a store |
| `polvenn_find_nearby_stores` | Find nearby Vinmonopolet stores by coordinates |
| `polvenn_watchlist` | Add, remove, list, and check watch rules |
| `polvenn_configure` | Store API key, home store, and home location |
| `polvenn_validate_config` | Validate config and probe live capabilities |

### Watchlist rules

The watchlist supports:

- `brewery`
- `style`
- `series`
- `keyword`

`check` compares the latest external release against all saved rules and tracks which matches are new since the previous check for that release.

---

## Current status

The project builds and tests cleanly.

Useful validation commands:

```bash
npx tsc --noEmit
npm run build
npm test
```

---

## Known limitations

1. The external release feed must expose the expected JSON shape for MCP lookups to work.
2. Vinmonopolet stock access may fail for users who only have `Open` subscription access.
3. Vinmonopolet API response shapes should still be verified against live responses over time.

---

## Conventions

- Dates: ISO 8601 `yyyy-MM-dd`
- Tool names: `polvenn_` prefix, snake_case
- Zod schemas: `.strict()`
- Errors: `{ isError: true, content: [{ type: "text", text: "..." }] }`
- Logging: `console.error()` only
- Avoid `any`; prefer `unknown` and type guards

---

## Development setup

```bash
npm install
npx tsc --noEmit
npm run build
npm start
```

### Codex integration

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.polvenn]
command = "node"
args = ["/Users/henrik/Repos/mcp-polvenn/dist/index.js"]
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
