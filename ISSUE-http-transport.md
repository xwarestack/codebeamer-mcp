# feat: optional streamable-HTTP transport with per-user credential passthrough

## Motivation

Today the server is stdio-only: every user needs Node, a clone, and a build on their machine, and every MCP client spawns its own process. That is the right default for individual use (zero network attack surface, credentials never leave the machine), but it does not scale to a team: setup is repeated per person and per machine, and updates have to be pulled everywhere.

A second, optional transport — the MCP **streamable-HTTP** transport — would allow one shared server deployed next to the Codebeamer instance. Users would then register it with a single command and no local installation:

```bash
claude mcp add --transport http codebeamer https://mcp.example.internal/mcp \
  --header "Authorization: Basic <base64 username:password>"
```

## Design

### Both transports, selected by config

stdio stays the default; nothing changes for existing setups.

| Variable | Values | Default |
|---|---|---|
| `CB_TRANSPORT` | `stdio`, `http` | `stdio` |
| `CB_PORT` | listen port in `http` mode | e.g. `3200` |

In `http` mode `CB_URL` (and `CB_MODE`, `CB_TIMEOUT_MS`, …) keep their meaning as server-side config; `CB_USERNAME`/`CB_PASSWORD` become optional (see below).

### Per-user credential passthrough — no shared service account

The central server must **not** flatten all users onto one Codebeamer account: that would bypass Codebeamer's per-user permissions and destroy audit trails. Instead:

- Each user keeps their Codebeamer credentials in their **own local MCP client config**, sent as an `Authorization: Basic …` header on every request (the standard `--header` option of MCP clients).
- The server reads the header per session, constructs that session's `CodebeamerClient` from it, and forwards the credentials to Codebeamer. It stores nothing.
- Requests without the header are rejected (401), so the endpoint is never an anonymous door into the API.
- Optional: if `CB_USERNAME`/`CB_PASSWORD` are set server-side, they can serve as a fallback for deployments that explicitly want a service account.

`CodebeamerClient` already takes credentials at construction, so a per-session client is a natural fit; the tool layer needs the client resolved per request/session instead of once at startup.

### Security requirements (http mode)

- **TLS is mandatory** — Basic credentials ride in every request header. Recommended deployment: behind a reverse proxy (nginx/Caddy) that terminates HTTPS, documented in the README.
- Never log request headers.
- `CB_MODE` remains enforced server-side; a client cannot escalate it per request.
- Document that the MCP endpoint should be reachable only from the intended network segment.

## Scope

- `src/index.ts`: transport selection; streamable-HTTP transport with session management from `@modelcontextprotocol/sdk`.
- `src/config.ts`: `CB_TRANSPORT`, `CB_PORT`; make credentials optional in http mode.
- Per-session `CodebeamerClient` construction from the `Authorization` header.
- Tests for header parsing/rejection and per-session client isolation.
- README: deployment section (reverse proxy, TLS, client registration), keeping the stdio quick start as the default path.

## Out of scope

- OAuth / SSO token support (possible follow-up if the Codebeamer instance supports bearer tokens).
- Multi-instance routing (one deployment serves one Codebeamer instance).
