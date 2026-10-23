# codebeamer-mcp

An MCP (Model Context Protocol) server for Codebeamer ALM. Allows Claude and other MCP clients to read and write projects, trackers, and items, review and compare tracker configuration, and reach the complete Codebeamer REST v3 API using natural language.

## Tools (35)

The server runs **read-only by default**. Write tools are only registered with `CB_MODE=write` or `CB_MODE=admin` (see [Access modes](#access-modes)).

### Read

| Tool | Description |
|---|---|
| `list_projects` | List all projects |
| `get_project` | Get project details |
| `list_trackers` | List trackers in a project |
| `get_tracker` | Get tracker details |
| `list_tracker_items` | List items in a tracker (shows the real total and whether more pages exist) |
| `search_items` | Full-text / cbQL search |
| `get_item` | Get item summary: ID, name, tracker, status and description. Lightweight — use when you only need to identify the item and read its content |
| `get_item_details` | Get full structured detail of an item: project, priority, assignees, timestamps, story points, custom fields and test steps. Description omitted — fetch it via `get_item` |
| `get_item_relations` | Get outgoing/incoming associations (depends on, blocks, …) |
| `get_item_references` | Get upstream/downstream traceability references (derived from, covers, …) |
| `get_item_comments` | Get item comments |
| `get_item_reviews` | Get Review Hub reviews for an item (result, reviewers, votes) |
| `get_user` | Get user details |
| `find_user` | Find users by username, name fragment or email to get their IDs |

### Configuration review

Connect with a project admin account to see full configuration; parts the account cannot read are reported instead of failing the whole call.

| Tool | Description |
|---|---|
| `get_tracker_configuration` | Settings, template relationship, all fields (type, mandatory/hidden rules, formulas, permissions, dependencies), statuses, choice options (enums) and reference fields. Markdown or JSON |
| `get_tracker_workflow` | Statuses and transitions (from/to, hidden, allowed roles) with a Mermaid state diagram |
| `get_tracker_permissions` | Tracker permissions per role, optionally filtered by role or user |
| `get_project_tracker_graph` | Which trackers reference which other trackers/projects, as a table and Mermaid diagram |
| `list_tracker_types` | Tracker types and their IDs |
| `list_roles` | Roles and their IDs |
| `list_association_types` | Association types and their IDs (needed by `create_association`) |
| `get_project_members` | Members of a project |

### Comparison

| Tool | Description |
|---|---|
| `compare_trackers` | Diff two trackers (same or different projects): settings, fields, options, reference targets, statuses, transitions, role permissions |
| `compare_tracker_with_template` | Diff a tracker against the template tracker it was derived from |
| `compare_projects` | Trackers present in only one project and type mismatches; `deep=true` also diffs every matched tracker and the reference graph |

### Full API access

The complete Codebeamer REST v3 API (188 operations, bundled in [docs/codebeamer-openapi-v3.json](docs/codebeamer-openapi-v3.json)) is reachable through four generic tools, so the agent is not limited to the dedicated tools above: attachments, wiki pages, baselines, reports, test runs, item history and children, locks, streams, permissions, and more.

| Tool | Description |
|---|---|
| `api_search_operations` | Search operations by keyword or area; without arguments lists all API areas |
| `api_describe_operation` | Parameters, request body schema, response type and required access level |
| `api_describe_schema` | Expand a named data type from the spec |
| `api_call` | Execute any operation. Operations are checked against `CB_MODE` before anything is sent |

### Write (`CB_MODE=write` or `admin`)

| Tool | Description |
|---|---|
| `create_item` | Create a new item in a tracker. Supports folders, item type, and parent nesting |
| `update_item` | Update an existing item (name, description, status, priority, assignee, story points). Refuses the whole update if a requested field does not exist in the tracker |
| `add_comment` | Add a comment to an item |
| `create_association` | Create an association between two items (e.g. depends on, blocks) |
| `create_reference` | Add a downstream traceability reference between two items |
| `create_harm` | Create a harm entry in an RM Harms List tracker with IMDRF code and severity (1–5) |

## Access modes

`CB_MODE` controls what the MCP client may change. Codebeamer's own permissions for the configured account still apply on top.

| Mode | Dedicated tools | `api_call` |
|---|---|---|
| `read` (default) | Read, configuration review and comparison tools | Read operations only (GET and query-style POSTs) |
| `write` | + write tools | + content changes: items, comments, associations, attachments, wiki, reviews, test runs, reports, baselines |
| `admin` | same as `write` | + everything else: tracker configuration, permissions, roles, deployment, streams |

Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`), so clients can auto-approve reads and ask before writes.

> ⚠️ **Upgrading from 0.5.x:** write tools now require `CB_MODE=write`. Without it the server is read-only.

> ⚠️ **Tracker configuration writes** (`postTrackerConfiguration` via `api_call`, `CB_MODE=admin`) replace the whole configuration. PTC documents that this endpoint can wipe existing configuration on some versions: always read the current configuration first and send it back complete.

### Example prompts

- "Show the workflow of tracker 1234 and list transitions only the Developer role can execute."
- "Compare tracker 1234 with its template and summarize the local deviations."
- "Compare projects 10 and 20 in depth and list trackers whose choice options differ."
- "Draw the tracker reference graph of project 10 and point out trackers nothing references."
- "Find the API operation for item history and show the last changes of item 5678."

## Installation

### Quick start (Claude Code)

One-time setup; afterward the server is available in every Claude Code session (CLI and VS Code) from any folder:

```bash
git clone https://github.com/xwarestack/codebeamer-mcp.git
cd codebeamer-mcp
npm ci && npm run build

claude mcp add codebeamer --scope user \
  -e CB_URL=https://your-instance.example.com/cb/api \
  -e CB_USERNAME=your_username -e CB_PASSWORD=your_password \
  -- node "$(pwd)/dist/index.js"
```

There is nothing to deploy or keep running: the MCP client starts and stops the server automatically in each session. Verify with `/mcp` inside a session **started in another folder** — inside the clone itself, the repository's own [.mcp.json](.mcp.json) takes precedence and expects the `CB_*` environment variables to be set (see [2a](#2a-claude-code-cli-or-vs-code-extension)). Then ask e.g. *"List the Codebeamer projects"*. Rebuild (`npm run build`) only after pulling new code. Details and other clients (Claude Desktop, Copilot, Cursor, …) below.

### Requirements

- Node.js 20+ and Git
- An MCP client: Claude Code (CLI or VS Code extension), Claude Desktop, VS Code with GitHub Copilot, Cursor, …
- Network access to your Codebeamer instance (VPN if it is internal) and an account. Configuration review needs project admin rights.

The package is **not published to npm yet**, so install from source (option A). The npm setups (option B) work after the first release.

### Option A: from source (use this today)

#### 1. Clone and build

Clone **this** repository, `xwarestack/codebeamer-mcp`, on its default branch `master`. The original `3KniGHtcZ/codebeamer-mcp` does not contain the configuration review, comparison and API tools.

```bash
git clone https://github.com/xwarestack/codebeamer-mcp.git
cd codebeamer-mcp
npm ci
npm run build
```

`dist/` is not in Git: run `npm run build` after the clone and again after every `git pull`.

The server is started by your MCP client with `node <repo>/dist/index.js`. Use the full path when the client is not started inside the repository.

#### 2a. Claude Code (CLI or VS Code extension)

The repository contains a [.mcp.json](.mcp.json) that Claude Code picks up when started inside the repository. It reads the connection from environment variables, so no credentials are stored in the file. Set them once per machine, e.g. in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("CB_URL", "https://your-instance.example.com/cb/api", "User")
[Environment]::SetEnvironmentVariable("CB_USERNAME", "your_username", "User")
[Environment]::SetEnvironmentVariable("CB_PASSWORD", "your_password", "User")
# optional, default is read
[Environment]::SetEnvironmentVariable("CB_MODE", "read", "User")
```

Restart the terminal (or VS Code) so new processes see them.

To use the server from any folder instead, register it for your user:

```powershell
claude mcp add codebeamer --scope user `
  -e CB_URL=https://your-instance.example.com/cb/api `
  -e CB_USERNAME=your_username -e CB_PASSWORD=your_password `
  -- node "C:\path\to\codebeamer-mcp\dist\index.js"
```

> Inside the repository, the project's `.mcp.json` server (also named `codebeamer`) takes precedence over a user-scoped one. Either set the environment variables above, or register yours with `--scope local` when working in the repository.

Check with `claude mcp list` (or `/mcp` in a session) that `codebeamer` is connected.

#### 2b. VS Code with GitHub Copilot

Copilot reads `.vscode/mcp.json`, not `.mcp.json`. Create it in the cloned repository (it is git-ignored):

```json
{
  "inputs": [
    { "type": "promptString", "id": "cb-password", "description": "Codebeamer password", "password": true }
  ],
  "servers": {
    "codebeamer": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "${input:cb-password}",
        "CB_MODE": "read"
      }
    }
  }
}
```

VS Code asks for the password on first start and stores it securely. Start the server from the **MCP: List Servers** command or the Start link above the server entry, then use the tools in Copilot Chat's agent mode.

#### 2c. Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "codebeamer": {
      "command": "node",
      "args": ["C:\\path\\to\\codebeamer-mcp\\dist\\index.js"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### 3. Test it

Ask the assistant, for example: *"List the Codebeamer projects"*, *"Show the configuration of tracker 1234"*, *"Compare tracker 1234 with its template"*.

To try every tool without an AI client, use the MCP Inspector, which opens in the browser:

```powershell
$env:CB_URL="https://your-instance.example.com/cb/api"; $env:CB_USERNAME="your_username"; $env:CB_PASSWORD="your_password"
npm run inspect
```

#### Troubleshooting

| Symptom | Cause |
|---|---|
| Server shows as failed / "Connection closed" | `dist/` not built (`npm run build`), or `CB_URL` / `CB_USERNAME` / `CB_PASSWORD` not set for the client process. Run `node dist/index.js` in a terminal to see the error. |
| "Cannot connect to Codebeamer" | Wrong `CB_URL` (it must include `/cb/api`), or the machine cannot reach the server (VPN, proxy, firewall). |
| "Authentication failed" | Wrong username or password. |
| Configuration tools report "Forbidden" or "Not available" sections | The account lacks project admin rights for that tracker. |
| Write tools are missing | The server runs with `CB_MODE=read` (default); see [Access modes](#access-modes). |

> ⚠️ **Never commit real credentials.** `.mcp.json` is committed and only references environment variables; keep it that way. `.vscode/` files with credentials stay local.

### Option B: from npm (after the first release)

Once `@xwarestack/codebeamer-mcp` is published (push a `v*` tag; requires the `xwarestack` npm organization and the `NPM_TOKEN` secret), no clone is needed: MCP clients start it with `npx`.

#### Claude Code (CLI)

The fastest way — run this command in your terminal:

```bash
claude mcp add codebeamer -e CB_URL=https://your-instance.example.com/cb/api \
  -e CB_USERNAME=your_username -e CB_PASSWORD=your_password \
  -- npx -y @xwarestack/codebeamer-mcp
```

Add `--scope user` to make it available in every project, or add it manually to `.mcp.json` in a project root:

```json
{
  "mcpServers": {
    "codebeamer": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### Claude Desktop

Edit the config file for your platform:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "codebeamer": {
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

#### Cursor

Add to `.cursor/mcp.json` in the project root (project scope) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "codebeamer": {
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "codebeamer": {
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### VS Code (Copilot)

Add to `.vscode/mcp.json` in the project root:

```json
{
  "servers": {
    "codebeamer": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "codebeamer": {
      "command": "npx",
      "args": ["-y", "@xwarestack/codebeamer-mcp"],
      "env": {
        "CB_URL": "https://your-instance.example.com/cb/api",
        "CB_USERNAME": "your_username",
        "CB_PASSWORD": "your_password"
      }
    }
  }
}
```

#### Alternative: global install

```bash
npm install -g @xwarestack/codebeamer-mcp
```

Then use `"command": "codebeamer-mcp"` (no `args`) instead of `npx` in any config above.

#### Pinning a specific version

```json
"args": ["-y", "@xwarestack/codebeamer-mcp@0.6.0"]
```

#### Updates

| Method | Update behavior |
|---|---|
| `npx -y @xwarestack/codebeamer-mcp` | Always fetches the latest version |
| `npm install -g @xwarestack/codebeamer-mcp` | Stays on installed version. Run `npm update -g @xwarestack/codebeamer-mcp` to update |
| Pinned version (`@0.6.0`) | Never auto-updates; change the version string manually |

## Development & Testing

```bash
# Run tests (no real Codebeamer instance needed)
npm test

# Start the mock API server (port 3001)
node mock-server.mjs

# Interactive testing via MCP Inspector
CB_URL=http://localhost:3001 CB_USERNAME=mock CB_PASSWORD=mock \
  npx @modelcontextprotocol/inspector node dist/index.js
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `CB_URL` | Codebeamer API URL, e.g. `https://your-instance.example.com/cb/api` (the server appends `/v3` automatically) | _(required)_ |
| `CB_USERNAME` | Login username | _(required)_ |
| `CB_PASSWORD` | Password | _(required)_ |
| `CB_UNSAFE_SSL` | Set to `true` to allow connections to servers with unverified/self-signed certificates | `false` |
| `CB_MODE` | `read`, `write` or `admin` — see [Access modes](#access-modes) | `read` |
| `CB_TIMEOUT_MS` | Request timeout (ms). Rate-limited requests (HTTP 429) are retried twice | `30000` |
| `CB_OPENAPI_SPEC` | File path or URL of an OpenAPI spec for the `api_*` tools, e.g. your instance's own `swagger.json` to match its exact version | bundled spec |