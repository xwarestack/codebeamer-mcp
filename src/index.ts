#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasAccess, loadConfig } from "./config.js";
import { HttpClient } from "./client/http-client.js";
import { CodebeamerClient } from "./client/codebeamer-client.js";
import { createCatalogLoader } from "./openapi/catalog.js";
import {
  registerProjectTools,
  registerTrackerTools,
  registerItemTools,
  registerItemDetailTools,
  registerUserTools,
  registerItemWriteTools,
  registerCommentWriteTools,
  registerAssociationWriteTools,
  registerRiskWriteTools,
  registerConfigurationTools,
  registerCompareTools,
  registerApiTools,
} from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const config = loadConfig();

if (config.unsafeSsl) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const server = new McpServer({
  name: "codebeamer",
  version,
});

const httpClient = new HttpClient({ ...config, userAgent: `codebeamer-mcp/${version}` });
const client = new CodebeamerClient(httpClient);

// Both src/index.ts and the bundled dist/index.js sit one level below the package root.
const bundledSpec = fileURLToPath(new URL("../docs/codebeamer-openapi-v3.json", import.meta.url));
const authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
const loadCatalog = createCatalogLoader(config.openApiSpec ?? bundledSpec, authHeader);

registerProjectTools(server, client);
registerTrackerTools(server, client);
registerItemTools(server, client);
registerItemDetailTools(server, client);
registerUserTools(server, client);
registerConfigurationTools(server, client);
registerCompareTools(server, client);
registerApiTools(server, httpClient, loadCatalog, config.mode);

if (hasAccess(config.mode, "write")) {
  registerItemWriteTools(server, client);
  registerCommentWriteTools(server, client);
  registerAssociationWriteTools(server, client);
  registerRiskWriteTools(server, client);
}

console.error(`[codebeamer-mcp] v${version} started in CB_MODE=${config.mode}`);

const transport = new StdioServerTransport();
await server.connect(transport);
