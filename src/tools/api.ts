import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, QueryValue } from "../client/http-client.js";
import { CbError } from "../client/errors.js";
import { hasAccess, type AccessMode } from "../config.js";
import type { OpenApiCatalog } from "../openapi/catalog.js";
import { cell } from "../formatters/item-formatter.js";
import { DESTRUCTIVE_WRITE, READ_ONLY } from "./annotations.js";

type Primitive = string | number | boolean;

export interface ApiCallArgs {
  operationId: string;
  pathParams?: Record<string, Primitive>;
  query?: Record<string, Primitive | Primitive[]>;
  body?: unknown;
  maxChars?: number;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    `${text.slice(0, maxChars)}\n… truncated (${maxChars} of ${text.length} characters). ` +
    `Narrow the request (paging, filters) or raise maxChars.`
  );
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

/** Validate and execute one OpenAPI operation against Codebeamer. Exported for tests. */
export async function executeApiCall(
  catalog: OpenApiCatalog,
  http: HttpClient,
  mode: AccessMode,
  args: ApiCallArgs,
): Promise<ToolResult> {
  const op = catalog.get(args.operationId);
  if (!op) {
    const suggestions = catalog.search(args.operationId, { limit: 5 }).map((o) => o.operationId);
    return {
      isError: true,
      text:
        `Unknown operationId "${args.operationId}".` +
        (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
        " Use api_search_operations to find operations.",
    };
  }

  const label = `${op.method.toUpperCase()} ${op.path}`;
  if (!hasAccess(mode, op.access)) {
    return {
      isError: true,
      text:
        `${op.operationId} (${label}) changes data and requires CB_MODE=${op.access}; the server runs with CB_MODE=${mode}. ` +
        `Restart the MCP server with CB_MODE=${op.access} only if this change is intended.`,
    };
  }
  if (!op.path.startsWith("/v3/")) {
    return { isError: true, text: `${label} is outside the /v3 API and is not supported by api_call.` };
  }

  const pathParams = args.pathParams ?? {};
  const missingPath: string[] = [];
  const path = op.path.slice(3).replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined) {
      missingPath.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(String(value));
  });
  const query = args.query ?? {};
  const missingQuery = op.parameters
    .filter((p) => p.in === "query" && p.required && query[p.name] === undefined)
    .map((p) => p.name);
  if (missingPath.length > 0 || missingQuery.length > 0) {
    return {
      isError: true,
      text:
        `Missing required parameters for ${op.operationId}: ` +
        [...missingPath.map((n) => `pathParams.${n}`), ...missingQuery.map((n) => `query.${n}`)].join(", ") +
        ". Use api_describe_operation to see all parameters.",
    };
  }

  const body = parseBody(args.body);
  if (body !== undefined && !op.requestBody) {
    return { isError: true, text: `${op.operationId} does not take a request body.` };
  }
  if (body === undefined && op.requestBody?.required) {
    return {
      isError: true,
      text: `${op.operationId} requires a request body (${op.requestBody.contentType}). Use api_describe_operation to see its schema.`,
    };
  }

  let formData: Record<string, string> | undefined;
  let jsonBody: unknown;
  if (body !== undefined && op.requestBody?.contentType.includes("multipart")) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { isError: true, text: `${op.operationId} expects multipart form fields as a JSON object.` };
    }
    formData = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
  } else {
    jsonBody = body;
  }

  const maxChars = args.maxChars ?? 40000;
  try {
    const response = await http.send(op.method.toUpperCase(), path, {
      params: query as Record<string, QueryValue>,
      body: jsonBody,
      formData,
      resource: label,
    });
    const rendered =
      response.body === undefined
        ? "(no content)"
        : typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
    return {
      text:
        `**${op.method.toUpperCase()} /v3${path}** → HTTP ${response.status}` +
        (response.contentType ? ` (${response.contentType})` : "") +
        `\n\n\`\`\`json\n${truncate(rendered, maxChars)}\n\`\`\``,
    };
  } catch (err) {
    if (err instanceof CbError) {
      const details = err.body === undefined ? "" : `\n\n${truncate(JSON.stringify(err.body), 4000)}`;
      return { isError: true, text: `HTTP ${err.status}: ${err.message}${details}` };
    }
    throw err;
  }
}

export function formatOperationSearch(
  catalog: OpenApiCatalog,
  query: string | undefined,
  tag: string | undefined,
  limit: number,
  mode: AccessMode,
): string {
  if (!query && !tag) {
    const tags = catalog.tags();
    return [
      `## Codebeamer API: ${catalog.operations.length} operations in ${tags.length} areas`,
      "",
      "| Tag | Operations |",
      "|---|---|",
      ...tags.map((t) => `| ${t.tag} | ${t.count} |`),
      "",
      "_Search with a query (e.g. \"transitions\", \"field options\") or a tag to list operations._",
    ].join("\n");
  }

  const results = catalog.search(query, { tag, limit });
  if (results.length === 0) return `_No operations match${query ? ` "${query}"` : ""}${tag ? ` in tag "${tag}"` : ""}._`;
  return [
    `## Operations (${results.length})`,
    "",
    "| operationId | Method | Path | Access | Summary |",
    "|---|---|---|---|---|",
    ...results.map(
      (op) =>
        `| ${op.operationId} | ${op.method.toUpperCase()} | ${op.path} | ${op.access}${hasAccess(mode, op.access) ? "" : " 🔒"} | ${cell(op.summary)}${op.deprecated ? " (deprecated)" : ""} |`,
    ),
    "",
    `_🔒 = not allowed with the current CB_MODE=${mode}. Use api_describe_operation for parameters and body schema._`,
  ].join("\n");
}

const primitive = z.union([z.string(), z.number(), z.boolean()]);

export function registerApiTools(
  server: McpServer,
  http: HttpClient,
  loadCatalog: () => Promise<OpenApiCatalog>,
  mode: AccessMode,
): void {
  server.registerTool(
    "api_search_operations",
    {
      title: "Search Codebeamer API Operations",
      description:
        "Search the full Codebeamer REST v3 API (OpenAPI spec) for operations not covered by the dedicated tools: " +
        "attachments, wiki pages, baselines, reports, test runs, history, children, locks, streams, permissions, etc. " +
        "Call without arguments to list API areas (tags). Then use api_describe_operation and api_call.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. 'item history', 'baseline', 'field options'"),
        tag: z.string().optional().describe("Restrict to one API area (tag), e.g. 'Wiki' or 'Test run'"),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum operations to return"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, tag, limit }) => {
      const catalog = await loadCatalog();
      return { content: [{ type: "text", text: formatOperationSearch(catalog, query, tag, limit, mode) }] };
    },
  );

  server.registerTool(
    "api_describe_operation",
    {
      title: "Describe Codebeamer API Operation",
      description:
        "Show the parameters, request body schema, response type and required access level of one API operation, " +
        "identified by the operationId returned by api_search_operations.",
      inputSchema: {
        operationId: z.string().min(1).describe("operationId, e.g. 'getTrackerItemHistory'"),
      },
      annotations: READ_ONLY,
    },
    async ({ operationId }) => {
      const catalog = await loadCatalog();
      const op = catalog.get(operationId);
      if (!op) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown operationId "${operationId}". Use api_search_operations.` }],
        };
      }
      return { content: [{ type: "text", text: catalog.describeOperation(op) }] };
    },
  );

  server.registerTool(
    "api_describe_schema",
    {
      title: "Describe Codebeamer API Schema",
      description:
        "Expand a named data type from the Codebeamer API spec (e.g. 'TrackerField', 'WorkflowTransition') " +
        "to see its properties. Use it to build request bodies for api_call or to interpret responses.",
      inputSchema: {
        name: z.string().min(1).describe("Schema name as shown in api_describe_operation output"),
      },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const catalog = await loadCatalog();
      const text = catalog.describeSchema(name);
      if (!text) {
        const similar = catalog
          .schemaNames()
          .filter((n) => n.toLowerCase().includes(name.toLowerCase()))
          .slice(0, 15);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown schema "${name}".${similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : ""}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "api_call",
    {
      title: "Call Codebeamer API Operation",
      description:
        "Execute any Codebeamer REST v3 operation by operationId and return the raw JSON response. " +
        "Read operations are always allowed; operations that change data require the server to run with " +
        `CB_MODE=write (content) or CB_MODE=admin (configuration). Current mode: ${mode}. ` +
        "Prefer the dedicated tools when one exists; describe the operation first to get parameter names.",
      inputSchema: {
        operationId: z.string().min(1).describe("operationId from api_search_operations"),
        pathParams: z
          .record(z.string(), primitive)
          .optional()
          .describe("Values for {placeholders} in the path, e.g. {\"itemId\": 123}"),
        query: z
          .record(z.string(), z.union([primitive, z.array(primitive)]))
          .optional()
          .describe("Query string parameters, e.g. {\"page\": 1, \"pageSize\": 50}"),
        body: z
          .any()
          .optional()
          .describe("Request body as a JSON value (object or array); multipart operations take an object of form fields"),
        maxChars: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .default(40000)
          .describe("Truncate the response after this many characters"),
      },
      // In read mode every mutating operation is refused, so the tool is effectively read-only.
      annotations: mode === "read" ? READ_ONLY : DESTRUCTIVE_WRITE,
    },
    async (args) => {
      const catalog = await loadCatalog();
      const result = await executeApiCall(catalog, http, mode, args);
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
    },
  );
}
