import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mockServer } from "../../setup.js";
import { HttpClient } from "../../../src/client/http-client.js";
import { CodebeamerClient } from "../../../src/client/codebeamer-client.js";
import { formatItem } from "../../../src/formatters/item-formatter.js";

const BASE = "https://test-cb.example.com/v3";

function makeClient() {
  const http = new HttpClient({
    baseUrl: BASE,
    username: "testuser",
    password: "testpass",
  });
  return new CodebeamerClient(http);
}

describe("create_item", () => {
  it("creates an item and returns formatted result", async () => {
    const client = makeClient();
    const item = await client.createItem(100, {
      name: "New bug report",
      description: "Something is broken",
      status: { id: 10 },
      priority: { id: 3 },
      storyPoints: 3,
    });

    expect(item.id).toBe(600);
    expect(item.name).toBe("New bug report");

    const text = formatItem(item);
    expect(text).toContain("[600]");
    expect(text).toContain("New bug report");
  });

  it("creates an item with minimal fields", async () => {
    const client = makeClient();
    const item = await client.createItem(100, {
      name: "Simple task",
    });

    expect(item.id).toBe(600);
    expect(item.name).toBe("Simple task");
  });
});

describe("update_item", () => {
  it("updates an item and returns formatted result", async () => {
    const client = makeClient();
    const item = await client.updateItem(500, {
      name: "Updated title",
      status: { id: 20 },
    });

    expect(item.id).toBe(500);

    const text = formatItem(item);
    expect(text).toContain("[500]");
  });

  it("refuses the whole update when a requested field does not exist in the tracker", async () => {
    let wrote = false;
    mockServer.use(
      http.get(`${BASE}/trackers/:id/schema`, () =>
        HttpResponse.json([{ id: 1, name: "Summary", legacyRestName: "name" }]),
      ),
      http.put(`${BASE}/items/:id/fields`, () => {
        wrote = true;
        return HttpResponse.json({});
      }),
    );

    const client = makeClient();
    await expect(client.updateItem(500, { name: "New", storyPoints: 3 })).rejects.toThrow(
      /no field for: storyPoints\. Nothing was updated/,
    );
    expect(wrote).toBe(false);
  });
});

describe("create_reference", () => {
  it("updates the downstream item in quiet mode", async () => {
    let quietMode: string | null = null;
    mockServer.use(
      http.get(`${BASE}/trackers/:id/schema`, () =>
        HttpResponse.json([{ id: 20, name: "Superordinate", legacyRestName: "superordinateRequirement" }]),
      ),
      http.get(`${BASE}/items/:id/fields`, () => HttpResponse.json({ editableFields: [] })),
      http.put(`${BASE}/items/:id/fields`, ({ request }) => {
        quietMode = new URL(request.url).searchParams.get("quietMode");
        return HttpResponse.json({});
      }),
    );

    await makeClient().createDownstreamReference(400, 500);
    expect(quietMode).toBe("true");
  });
});
