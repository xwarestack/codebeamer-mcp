import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mockServer } from "../../setup.js";
import { makeItem } from "../../mocks/fixtures/items.js";
import { HttpClient } from "../../../src/client/http-client.js";
import { CodebeamerClient } from "../../../src/client/codebeamer-client.js";
import {
  formatItemList,
  formatItemSummary,
} from "../../../src/formatters/item-formatter.js";

const BASE = "https://test-cb.example.com/v3";

function makeClient() {
  const http = new HttpClient({
    baseUrl: BASE,
    username: "testuser",
    password: "testpass",
  });
  return new CodebeamerClient(http);
}

describe("search_items", () => {
  it("returns formatted search results", async () => {
    const client = makeClient();
    const result = await client.searchItems('tracker.id IN (100)', 1, 25);
    const text = formatItemList(result.items, { total: result.total, page: 1, pageSize: 25 });

    expect(text).toContain("## Items (2)");
    expect(text).toContain("Login button does not respond");
    expect(text).toContain("Another bug");
  });

  it("reports the API total from paginated query results", async () => {
    mockServer.use(
      http.get(`${BASE}/items/query`, () =>
        HttpResponse.json({ items: [makeItem()], page: 1, pageSize: 1, total: 42 }),
      ),
    );
    const client = makeClient();
    const result = await client.searchItems("tracker.id IN (100)", 1, 1);

    expect(result.total).toBe(42);
    expect(formatItemList(result.items, { total: result.total, page: 1, pageSize: 1 })).toContain("1 of 42");
  });
});

describe("list_tracker_items", () => {
  it("returns formatted item list", async () => {
    const client = makeClient();
    const { items } = await client.listTrackerItems(100, 1, 25);
    const text = formatItemList(items);

    expect(text).toContain("## Items");
    expect(text).toContain("500");
    expect(text).toContain("Open");
    expect(text).toContain("High");
  });
});

describe("get_item", () => {
  it("returns lightweight summary (id, name, tracker, status, description)", async () => {
    const client = makeClient();
    const item = await client.getItem(500);
    const text = formatItemSummary(item);

    expect(text).toContain("[500] Login button does not respond");
    expect(text).toContain("**Tracker:** Bug Tracker");
    expect(text).toContain("**Status:** Open");
    expect(text).toContain("### Description");
    expect(text).toContain("Steps to reproduce");

    expect(text).not.toContain("**Priority:**");
    expect(text).not.toContain("**Story Points:**");
    expect(text).not.toContain("### Custom Fields");
    expect(text).not.toContain("Environment");
    expect(text).not.toContain("Authentication");
  });
});
