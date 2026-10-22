# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # compile TypeScript → dist/ (tsup, ESM)
npm run dev            # watch mode build
npm run typecheck      # type-check without emitting
npm test               # run all tests once (vitest)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # coverage report

# Run a single test file
npx vitest run tests/unit/tools/items.test.ts

# Interactive MCP testing (requires a running instance or mock server)
node mock-server.mjs                        # start mock API on port 3001
CB_URL=http://localhost:3001 CB_USERNAME=mock CB_PASSWORD=mock npm run inspect
```

## Architecture

The server exposes Codebeamer ALM data to LLM clients via stdio transport: item read/write tools, tracker configuration review and comparison tools, and generic tools that reach the whole REST v3 API through the bundled OpenAPI spec.

```
src/
  index.ts                  # entry point: wires McpServer + transport, registers tools per CB_MODE
  config.ts                 # env config: CB_URL / CB_USERNAME / CB_PASSWORD / CB_MODE / CB_TIMEOUT_MS / CB_OPENAPI_SPEC
  client/
    http-client.ts          # fetch wrapper (Basic Auth, query params, timeout, 429 retry, error mapping); send() for raw calls
    codebeamer-client.ts    # typed Codebeamer API methods + response types
    errors.ts               # maps HTTP status codes to CbError subclasses
  openapi/catalog.ts        # loads the OpenAPI spec; search/describe operations; classifies each as read/write/admin
  analysis/                 # pure logic: tracker snapshot loading, normalization, diffs, reference graph
  formatters/               # convert API types → markdown strings for tool responses
  tools/                    # register MCP tools on the server (one file per domain)
    annotations.ts          # readOnlyHint/destructiveHint presets; every tool sets one
    index.ts                # re-exports all register* functions
```

**Data flow:** `McpServer` → `register*Tools(server, client)` → `CodebeamerClient` → `HttpClient` → Codebeamer REST API v3. Responses are formatted to markdown by the formatters before being returned as tool content.

### Access modes

`CB_MODE` (`read` default, `write`, `admin`) decides what can change data. Write tools are only registered in `write`/`admin`. `api_call` checks each operation's access level from `classifyAccess()` in `openapi/catalog.ts` before sending: GET and query-style POSTs are `read`, mutations under content tags (items, comments, wiki, test runs, …) are `write`, everything else (tracker configuration, permissions, deployment, …) is `admin`. Keep that classification conservative when adding tags.

### Key implementation details

**`toArray<T>(response)`** in `codebeamer-client.ts` — normalises the inconsistent API response shapes:
- plain `T[]`
- `{ items: T[] }` (query endpoint)
- `{ itemRefs: T[] }` (direct tracker items endpoint)
- generic fallback: first array-valued key in the object

**`listTrackerItems`** — uses `/items/query` with cbQL (`tracker.id IN (id)`) as primary endpoint. When empty, falls back to `/trackers/{id}/items` and returns a `debug` string with raw API output that the tool appends to the response.

**Relations vs References** — `getItemRelations` returns `CbItemRelationsPage` with four named arrays:
- `outgoingAssociations` / `incomingAssociations` → shown by `get_item_relations`
- `upstreamReferences` / `downstreamReferences` → shown by `get_item_references`

**Tracker configuration** — `GET /tracker/{id}/configuration` (singular `tracker`) returns `basicInformation` + `fields`, but config fields only carry `referenceId` (the field ID) and a numeric `typeId`. `normalizeTracker()` joins them with `/trackers/{id}/schema` for names, type names and built-in identity (`legacyRestName`/`trackerItemField`). Custom field IDs start at 10000 in every tracker, so comparisons match built-in fields by identity and custom fields by name, never by ID. Choice settings are told apart by shape (`choiceOptions` = enum, `referenceFilters` = references to trackers/projects). Only the configuration is mandatory when loading a snapshot; schema, transitions and permissions degrade to warnings when the account's role cannot read them.

**Not in the API:** workflow transition guards/actions/conditions. Transitions are readable (`/trackers/{id}/transitions`) but cannot be edited via REST.

### API reference

`docs/codebeamer-openapi-v3.json` is the full Codebeamer REST v3 OpenAPI spec (188 operations), exported from a live instance's `/v3/swagger.json`. It ships in the npm package (see `files` in package.json) because the `api_*` tools load it at runtime. Check endpoint paths, query params (e.g. `quietMode`, `version`, `baselineId`) and response schemas there before adding or changing client methods. The `servers` URL is a placeholder; real instances serve the API under `<host>/cb/api/v3`. Never commit a spec containing a customer's internal hostname.

## Tests

Tests use **MSW** (Mock Service Worker) to intercept `fetch` calls. No real Codebeamer instance is needed.

- `tests/setup.ts` — starts/stops the MSW server globally
- `tests/mocks/handlers.ts` — defines all intercepted routes
- `tests/mocks/fixtures/` — factory functions (`makeItem()`, `makeTracker()`, …) for test data

Tests call `CodebeamerClient` methods directly and assert on the formatted markdown output. There are no tool-layer tests; tool files are thin wrappers and are tested implicitly through the client+formatter tests. Exceptions with real logic live outside the tool callbacks and are tested directly: `executeApiCall()` (`tests/unit/tools/api.test.ts`), the catalog against the bundled spec, and `analysis/` against `fixtures/configuration.ts` (template tracker 900, derived tracker 901 with deliberate differences).

Register literal routes (`/trackers/types`, `/users/findByEmail`) before parameterised ones (`/trackers/:id`, `/users/:id`) in `handlers.ts`, otherwise MSW matches the parameter.
