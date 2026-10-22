import { readFile } from "node:fs/promises";
import type { AccessMode } from "../config.js";

type Json = Record<string, unknown>;

export interface ApiParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: Json;
}

export interface ApiOperation {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  deprecated: boolean;
  parameters: ApiParameter[];
  requestBody?: { contentType: string; required: boolean; schema?: Json };
  responseSchema?: Json;
  /** Minimum CB_MODE needed to call this operation. */
  access: AccessMode;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// POST endpoints that only query or render data.
const READ_ONLY_POSTS = [
  /^\/v3\/items\/query$/,
  /^\/v3\/items\/relations$/,
  /^\/v3\/items\/attachments\/content$/,
  /^\/v3\/users\/search$/,
  /^\/v3\/projects\/search$/,
  /^\/v3\/projects\/\{[^}]+\}\/trackers\/search$/,
  /^\/v3\/projects\/\{[^}]+\}\/wiki2html$/,
  /^\/v3\/traceability\/(items|relations)$/,
  /^\/v3\/export\/(items|tracker-item-reviews|exportToWord)$/,
  /^\/v3\/sysadmin\/audit\/permissions$/,
];

// Tags whose mutating operations change project content (items, links, wiki, tests).
// Mutations under any other tag (tracker configuration, permissions, deployment, ...) need admin.
const CONTENT_TAGS = new Set([
  "tracker item",
  "tracker item's attachment",
  "tracker item's comment",
  "attachment",
  "association",
  "wiki",
  "wiki's comment",
  "review hub",
  "test run",
  "test management",
  "report",
  "tracker report",
  "baseline",
  "tracker item move",
  "export",
]);

export function classifyAccess(method: string, path: string, tag: string): AccessMode {
  if (method === "get") return "read";
  if (method === "post" && READ_ONLY_POSTS.some((re) => re.test(path))) return "read";
  return CONTENT_TAGS.has(tag.trim().toLowerCase()) ? "write" : "admin";
}

// Words agents commonly use that the spec phrases differently.
const SYNONYMS: Record<string, string[]> = {
  enum: ["option", "choice"],
  enums: ["option", "choice"],
  workflow: ["transition"],
  link: ["association", "relation"],
  links: ["association", "relation"],
  config: ["configuration"],
};

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function oneLine(text: string | undefined, max = 140): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class OpenApiCatalog {
  private readonly ops: ApiOperation[] = [];
  private readonly byId = new Map<string, ApiOperation>();
  private readonly schemas: Record<string, Json>;

  constructor(doc: Json) {
    const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
    this.schemas = ((doc.components as Json | undefined)?.schemas ?? {}) as Record<string, Json>;

    for (const [path, item] of Object.entries(paths)) {
      const shared = (item.parameters ?? []) as Json[];
      for (const method of HTTP_METHODS) {
        const op = item[method] as Json | undefined;
        if (!op) continue;
        const tag = (((op.tags as string[] | undefined) ?? [])[0] ?? "Other").trim();
        const operationId = (op.operationId as string | undefined) ?? `${method}_${path}`;
        const parameters = [...shared, ...((op.parameters ?? []) as Json[])].map((p) => ({
          name: String(p.name),
          in: String(p.in),
          required: p.required === true || p.in === "path",
          description: p.description as string | undefined,
          schema: p.schema as Json | undefined,
        }));
        const body = op.requestBody as Json | undefined;
        const bodyContent = body?.content as Record<string, Json> | undefined;
        const bodyType = bodyContent ? Object.keys(bodyContent)[0] : undefined;
        const responses = (op.responses ?? {}) as Record<string, Json>;
        const okKey = Object.keys(responses).find((k) => k.startsWith("2"));
        const okContent = okKey ? (responses[okKey].content as Record<string, Json> | undefined) : undefined;

        const operation: ApiOperation = {
          operationId,
          method,
          path,
          tag,
          summary: (op.summary as string | undefined) ?? "",
          description: (op.description as string | undefined) ?? "",
          deprecated: op.deprecated === true,
          parameters,
          requestBody: bodyType
            ? {
                contentType: bodyType,
                required: body?.required === true,
                schema: bodyContent?.[bodyType]?.schema as Json | undefined,
              }
            : undefined,
          responseSchema: okContent ? (Object.values(okContent)[0]?.schema as Json | undefined) : undefined,
          access: classifyAccess(method, path, tag),
        };
        this.ops.push(operation);
        this.byId.set(operationId.toLowerCase(), operation);
      }
    }
  }

  get operations(): readonly ApiOperation[] {
    return this.ops;
  }

  get(operationId: string): ApiOperation | undefined {
    return this.byId.get(operationId.toLowerCase());
  }

  tags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const op of this.ops) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  search(query: string | undefined, options: { tag?: string; limit?: number } = {}): ApiOperation[] {
    const tag = options.tag?.trim().toLowerCase();
    let candidates = tag ? this.ops.filter((op) => op.tag.toLowerCase() === tag) : [...this.ops];

    const tokens = (query ?? "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    if (tokens.length > 0) {
      const scored = candidates.map((op) => {
        const primary = `${op.operationId.replace(/([a-z])([A-Z])/g, "$1 $2")} ${op.summary}`.toLowerCase();
        const path = op.path.toLowerCase();
        const secondary = `${op.tag} ${op.description}`.toLowerCase();
        let score = 0;
        let matched = 0;
        for (const token of tokens) {
          const variants = [token, ...(SYNONYMS[token] ?? [])];
          const hit = (text: string) => variants.some((v) => text.includes(v));
          const tokenScore = (hit(primary) ? 3 : 0) + (hit(path) ? 2 : 0) + (hit(secondary) ? 1 : 0);
          if (tokenScore > 0) matched++;
          score += tokenScore;
        }
        return { op, score, matched };
      });
      candidates = scored
        .filter((s) => s.matched > 0)
        .sort((a, b) => b.matched - a.matched || b.score - a.score || a.op.path.localeCompare(b.op.path))
        .map((s) => s.op);
    }
    return candidates.slice(0, options.limit ?? 25);
  }

  schemaNames(): string[] {
    return Object.keys(this.schemas);
  }

  /** Markdown description of an operation: parameters, request body (expanded one level) and response type. */
  describeOperation(op: ApiOperation): string {
    const lines = [
      `## ${op.method.toUpperCase()} ${op.path}`,
      "",
      `- **operationId:** \`${op.operationId}\``,
      `- **Tag:** ${op.tag}`,
      `- **Access:** ${op.access}${op.access === "read" ? "" : ` (requires CB_MODE=${op.access} or higher)`}`,
    ];
    if (op.deprecated) lines.push("- **Deprecated**");
    if (op.summary) lines.push("", op.summary);
    if (op.description && op.description !== op.summary) lines.push("", op.description.trim());

    if (op.parameters.length > 0) {
      lines.push("", "### Parameters", "", "| Name | In | Type | Required | Description |", "|---|---|---|---|---|");
      for (const p of op.parameters) {
        lines.push(
          `| ${p.name} | ${p.in} | ${this.typeExpr(p.schema)} | ${p.required ? "yes" : "no"} | ${oneLine(p.description).replace(/\|/g, "\\|")} |`,
        );
      }
    }

    if (op.requestBody) {
      lines.push(
        "",
        `### Request body (${op.requestBody.contentType}${op.requestBody.required ? ", required" : ""})`,
        "",
        "```ts",
        this.renderSchema(op.requestBody.schema),
        "```",
      );
      if (op.requestBody.contentType.includes("multipart")) {
        lines.push("", "_Multipart: `api_call` sends body properties as text form fields; file uploads are not supported._");
      }
    }

    lines.push("", `### Response`, "", `\`${this.typeExpr(op.responseSchema) || "no content"}\``);
    lines.push("", "_Use api_describe_schema to expand nested types._");
    return lines.join("\n");
  }

  /** Markdown description of a named component schema, or undefined if it does not exist. */
  describeSchema(name: string): string | undefined {
    const key = this.schemas[name]
      ? name
      : Object.keys(this.schemas).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) return undefined;
    return [`## Schema ${key}`, "", "```ts", this.renderSchema({ $ref: `#/components/schemas/${key}` }), "```"].join("\n");
  }

  private resolve(schema: Json | undefined): Json | undefined {
    if (schema && typeof schema.$ref === "string") return this.schemas[refName(schema.$ref)];
    return schema;
  }

  /** Compact type expression; named schemas stay as names so output remains small. */
  typeExpr(schema: Json | undefined): string {
    if (!schema) return "";
    if (typeof schema.$ref === "string") return refName(schema.$ref);
    if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    for (const key of ["oneOf", "anyOf"]) {
      if (Array.isArray(schema[key])) return (schema[key] as Json[]).map((s) => this.typeExpr(s)).join(" | ");
    }
    if (Array.isArray(schema.allOf)) return (schema.allOf as Json[]).map((s) => this.typeExpr(s)).join(" & ");
    if (schema.type === "array") return `${this.typeExpr(schema.items as Json | undefined) || "unknown"}[]`;
    if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `Record<string, ${this.typeExpr(schema.additionalProperties as Json) || "unknown"}>`;
    }
    return String(schema.type ?? "object");
  }

  /** Render a schema with its properties (one level deep, inheriting allOf parents). */
  renderSchema(schema: Json | undefined): string {
    if (!schema) return "(no schema)";
    const name = typeof schema.$ref === "string" ? refName(schema.$ref) : undefined;
    const target = this.resolve(schema);
    if (!target) return name ?? "(unknown schema)";

    if (target.type === "array") {
      const item = target.items as Json | undefined;
      return `${this.typeExpr(target)}\n\n${this.renderSchema(item)}`;
    }

    const props: Record<string, Json> = {};
    const required = new Set<string>();
    const collect = (s: Json | undefined) => {
      const r = this.resolve(s);
      if (!r) return;
      for (const parent of (r.allOf ?? []) as Json[]) collect(parent);
      Object.assign(props, (r.properties ?? {}) as Record<string, Json>);
      for (const req of (r.required ?? []) as string[]) required.add(req);
    };
    collect(target);

    const lines = target.description ? [`// ${oneLine(String(target.description), 200)}`] : [];
    lines.push(name ?? "object");
    const entries = Object.entries(props);
    if (entries.length === 0 && !target.discriminator) {
      lines.push(`  (${this.typeExpr(target)})`);
    }
    if (entries.length > 0) {
      lines[lines.length - 1] += " {";
      for (const [prop, propSchema] of entries) {
        const desc = oneLine(propSchema.description as string | undefined, 120);
        lines.push(
          `  ${prop}${required.has(prop) ? "" : "?"}: ${this.typeExpr(propSchema)}${desc ? `  // ${desc}` : ""}`,
        );
      }
      lines.push("}");
    }
    const discriminator = target.discriminator as { propertyName?: string; mapping?: Record<string, string> } | undefined;
    if (discriminator?.mapping) {
      lines.push(
        `// Subtypes by "${discriminator.propertyName}": ` +
          Object.entries(discriminator.mapping)
            .map(([value, ref]) => `${value} → ${refName(ref)}`)
            .join(", "),
      );
    }
    return lines.join("\n");
  }
}

/** Read an OpenAPI document from a file path or an http(s) URL (fetched with the given auth header). */
export async function loadOpenApiDocument(source: string, authHeader?: string): Promise<Json> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { Accept: "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    });
    if (!response.ok) throw new Error(`Cannot load OpenAPI spec from ${source}: HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(source, "utf8");
  }
  // Specs copied from the browser's Swagger UI can contain non-breaking spaces as indentation.
  return JSON.parse(text.replace(/ /g, " ")) as Json;
}

/** Lazily load and cache the catalog; a failed load is retried on the next call. */
export function createCatalogLoader(source: string, authHeader?: string): () => Promise<OpenApiCatalog> {
  let pending: Promise<OpenApiCatalog> | undefined;
  return () => {
    pending ??= loadOpenApiDocument(source, authHeader)
      .then((doc) => new OpenApiCatalog(doc))
      .catch((err) => {
        pending = undefined;
        throw err;
      });
    return pending;
  };
}
