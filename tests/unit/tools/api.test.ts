import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { mockServer } from "../../setup.js";
import { HttpClient } from "../../../src/client/http-client.js";
import { OpenApiCatalog, loadOpenApiDocument } from "../../../src/openapi/catalog.js";
import { executeApiCall, formatOperationSearch } from "../../../src/tools/api.js";

const BASE = "https://test-cb.example.com/v3";
const SPEC = fileURLToPath(new URL("../../../docs/codebeamer-openapi-v3.json", import.meta.url));

let catalog: OpenApiCatalog;
const httpClient = new HttpClient({ baseUrl: BASE, username: "testuser", password: "testpass" });

beforeAll(async () => {
  catalog = new OpenApiCatalog(await loadOpenApiDocument(SPEC));
});

const opId = (method: string, path: string) =>
  catalog.operations.find((o) => o.method === method && o.path === path)!.operationId;

describe("executeApiCall", () => {
  it("calls a read operation with path and query params", async () => {
    let receivedUrl = "";
    mockServer.use(
      http.get(`${BASE}/items/:itemId/children`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ page: 1, pageSize: 10, total: 1, itemRefs: [{ id: 7, name: "Child" }] });
      }),
    );

    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("get", "/v3/items/{itemId}/children"),
      pathParams: { itemId: 500 },
      query: { pageSize: 10 },
    });

    expect(result.isError).toBeUndefined();
    expect(new URL(receivedUrl).pathname).toBe("/v3/items/500/children");
    expect(new URL(receivedUrl).searchParams.get("pageSize")).toBe("10");
    expect(result.text).toContain("GET /v3/items/500/children** → HTTP 200");
    expect(result.text).toContain('"name":"Child"');
  });

  it("refuses write operations in read mode without sending a request", async () => {
    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("delete", "/v3/items/{itemId}"),
      pathParams: { itemId: 500 },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("requires CB_MODE=write");
  });

  it("refuses configuration changes in write mode", async () => {
    const result = await executeApiCall(catalog, httpClient, "write", {
      operationId: opId("post", "/v3/tracker/configuration"),
      body: {},
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("requires CB_MODE=admin");
  });

  it("allows query-style POST operations in read mode and sends the JSON body", async () => {
    let receivedBody: unknown;
    mockServer.use(
      http.post(`${BASE}/users/search`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ users: [], total: 0 });
      }),
    );

    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("post", "/v3/users/search"),
      body: '{"name":"john"}',
    });

    expect(result.isError).toBeUndefined();
    expect(receivedBody).toEqual({ name: "john" });
  });

  it("sends multipart operations as form fields", async () => {
    let comment: FormDataEntryValue | null = null;
    mockServer.use(
      http.post(`${BASE}/items/:itemId/comments`, async ({ request }) => {
        comment = (await request.formData()).get("comment");
        return HttpResponse.json({ id: 1 });
      }),
    );

    const result = await executeApiCall(catalog, httpClient, "write", {
      operationId: opId("post", "/v3/items/{itemId}/comments"),
      pathParams: { itemId: 500 },
      body: { comment: "Reviewed" },
    });

    expect(result.isError).toBeUndefined();
    expect(comment).toBe("Reviewed");
  });

  it("reports missing required parameters", async () => {
    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("get", "/v3/users/findByName"),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("query.name");
  });

  it("suggests operations for an unknown operationId", async () => {
    const result = await executeApiCall(catalog, httpClient, "read", { operationId: "trackerTransitions" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Did you mean");
  });

  it("returns API errors with their body instead of throwing", async () => {
    mockServer.use(
      http.get(`${BASE}/wikipages/:wikiId`, () =>
        HttpResponse.json({ message: "Wiki page not visible", resourceUri: "/wikipages/3" }, { status: 400 }),
      ),
    );

    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("get", "/v3/wikipages/{wikiId}"),
      pathParams: { wikiId: 3 },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("HTTP 400: Validation error: Wiki page not visible");
    expect(result.text).toContain("resourceUri");
  });

  it("truncates large responses", async () => {
    mockServer.use(
      http.get(`${BASE}/roles`, () => HttpResponse.json(Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Role ${i}` })))),
    );

    const result = await executeApiCall(catalog, httpClient, "read", {
      operationId: opId("get", "/v3/roles"),
      maxChars: 1000,
    });

    expect(result.text).toContain("truncated (1000 of");
  });
});

describe("formatOperationSearch", () => {
  it("lists API areas when called without filters", () => {
    const text = formatOperationSearch(catalog, undefined, undefined, 25, "read");
    expect(text).toContain("188 operations");
    expect(text).toContain("| Wiki | 13 |");
  });

  it("marks operations not allowed in the current mode", () => {
    const text = formatOperationSearch(catalog, "tracker configuration", undefined, 10, "read");
    expect(text).toMatch(/\/v3\/tracker\/configuration \| admin 🔒/);
  });
});
