import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import {
  OpenApiCatalog,
  classifyAccess,
  createCatalogLoader,
  loadOpenApiDocument,
} from "../../../src/openapi/catalog.js";

const SPEC = fileURLToPath(new URL("../../../docs/codebeamer-openapi-v3.json", import.meta.url));

let catalog: OpenApiCatalog;

beforeAll(async () => {
  catalog = new OpenApiCatalog(await loadOpenApiDocument(SPEC));
});

describe("OpenApiCatalog (bundled Codebeamer v3 spec)", () => {
  it("indexes every operation", () => {
    expect(catalog.operations).toHaveLength(188);
    expect(catalog.tags().find((t) => t.tag === "Tracker item")?.count).toBe(29);
  });

  it("looks up operations by operationId, case-insensitively", () => {
    const op = catalog.get("getTrackerConfiguration");
    expect(op?.path).toBe("/v3/tracker/{trackerId}/configuration");
    expect(catalog.get("GETTRACKERCONFIGURATION")).toBe(op);
  });

  it("finds operations by keyword and synonym", () => {
    expect(catalog.search("tracker transitions").map((o) => o.path)).toContain("/v3/trackers/{trackerId}/transitions");
    expect(catalog.search("workflow").map((o) => o.path)).toContain("/v3/items/{itemId}/transitions");
    expect(catalog.search("history", { tag: "Wiki" }).every((o) => o.tag === "Wiki")).toBe(true);
  });

  it("describes an operation with parameters, body and access", () => {
    const op = catalog.search("update tracker configuration").find((o) => o.method === "post")!;
    const text = catalog.describeOperation(op);

    expect(text).toContain("POST /v3/tracker/configuration");
    expect(text).toContain("**Access:** admin");
    expect(text).toContain("TrackerConfiguration {");
    expect(text).toContain("fields?: TrackerField[]");
  });

  it("expands named schemas including discriminator subtypes", () => {
    expect(catalog.describeSchema("trackerfield")).toContain("mandatory?: boolean");
    expect(catalog.describeSchema("BaseTrackerFieldChoiceOption")).toContain("CHOICE_TRACKERS → ChoiceTrackers");
    expect(catalog.describeSchema("NoSuchSchema")).toBeUndefined();
  });
});

describe("classifyAccess", () => {
  it("treats reads and query-style POSTs as read", () => {
    expect(classifyAccess("get", "/v3/items/{itemId}", "Tracker item")).toBe("read");
    expect(classifyAccess("post", "/v3/items/query", "Tracker item")).toBe("read");
    expect(classifyAccess("post", "/v3/projects/{projectId}/trackers/search", "Project")).toBe("read");
  });

  it("requires write for content changes and admin for configuration changes", () => {
    expect(classifyAccess("put", "/v3/items/{itemId}/fields", "Tracker item")).toBe("write");
    expect(classifyAccess("delete", "/v3/associations/{associationId}", "Association")).toBe("write");
    expect(classifyAccess("post", "/v3/tracker/configuration", "Tracker")).toBe("admin");
    expect(classifyAccess("put", "/v3/trackers/{trackerId}/roles/{roleId}/permissions", "Tracker permission")).toBe("admin");
    // Permission changes stay admin-only even under a content tag.
    expect(classifyAccess("put", "/v3/wikipages/{wikiId}/permissions", "Wiki")).toBe("admin");
    expect(classifyAccess("get", "/v3/wikipages/{wikiId}/permissions", "Wiki")).toBe("read");
    expect(classifyAccess("post", "/v3/deployment", "Deployment")).toBe("admin");
  });

  it("classifies every operation in the spec", () => {
    const counts = { read: 0, write: 0, admin: 0 };
    for (const op of catalog.operations) counts[op.access]++;
    expect(counts.read + counts.write + counts.admin).toBe(188);
    expect(counts.admin).toBeGreaterThan(0);
  });
});

describe("loadOpenApiDocument", () => {
  it("tolerates non-breaking-space indentation from browser copies", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "cb-spec-"));
    const file = join(dir, "spec.txt");
    await writeFile(file, '{\n "openapi": "3.0.1",\n "paths": {}\n}');

    const doc = await loadOpenApiDocument(file);
    expect(doc.openapi).toBe("3.0.1");
  });

  it("retries after a failed load", async () => {
    const load = createCatalogLoader("does-not-exist.json");
    await expect(load()).rejects.toThrow();
    await expect(load()).rejects.toThrow();
  });
});
