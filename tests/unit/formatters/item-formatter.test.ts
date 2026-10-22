import { describe, it, expect } from "vitest";
import {
  formatItemList,
  formatItem,
  formatRelations,
  formatReferences,
  formatComments,
} from "../../../src/formatters/item-formatter.js";
import { makeItem, makeItemRelationsPage, makeComment } from "../../mocks/fixtures/items.js";

describe("formatItemList", () => {
  it("formats empty list", () => {
    const text = formatItemList([]);
    expect(text).toContain("No items found");
  });

  it("formats list with items", () => {
    const text = formatItemList([makeItem(), makeItem({ id: 501, name: "Bug #2", status: { id: 11, name: "Closed" } })]);
    expect(text).toContain("| 500 |");
    expect(text).toContain("| 501 |");
    expect(text).toContain("Closed");
    expect(text).toContain("## Items (2)");
  });

  it("shows the real total and a next-page hint when more pages exist", () => {
    const text = formatItemList([makeItem()], { total: 60, page: 1, pageSize: 25 });
    expect(text).toContain("## Items (1 of 60, page 1)");
    expect(text).toContain("request page 2");
  });

  it("omits the next-page hint on the last page", () => {
    const text = formatItemList([makeItem()], { total: 26, page: 2, pageSize: 25 });
    expect(text).not.toContain("request page");
  });

  it("escapes pipes in item names so the table stays intact", () => {
    const text = formatItemList([makeItem({ name: "A | B" })]);
    expect(text).toContain("A \\| B");
  });
});

describe("formatItem", () => {
  it("formats full item", () => {
    const text = formatItem(makeItem());
    expect(text).toContain("[500]");
    expect(text).toContain("Bug Tracker");
    expect(text).toContain("Story Points");
    expect(text).toContain("Custom Fields");
  });

  it("handles missing optional fields", () => {
    const text = formatItem(makeItem({ storyPoints: undefined, customFields: [], description: undefined }));
    expect(text).not.toContain("Story Points");
    expect(text).not.toContain("Custom Fields");
    expect(text).not.toContain("Description");
  });
});

describe("formatRelations", () => {
  it("formats empty relations", () => {
    expect(formatRelations({})).toContain("No associations");
  });

  it("formats outgoing and incoming associations", () => {
    const text = formatRelations(makeItemRelationsPage());
    expect(text).toContain("Outgoing");
    expect(text).toContain("depends on");
    expect(text).toContain("501");
    expect(text).toContain("Incoming");
    expect(text).toContain("blocks");
  });
});

describe("formatReferences", () => {
  it("formats empty references", () => {
    expect(formatReferences({})).toContain("No references");
  });

  it("formats upstream and downstream references", () => {
    const text = formatReferences(makeItemRelationsPage());
    expect(text).toContain("Upstream");
    expect(text).toContain("derived from");
    expect(text).toContain("Downstream");
    expect(text).toContain("covers");
  });
});

describe("formatComments", () => {
  it("formats empty comments", () => {
    expect(formatComments([])).toContain("No comments");
  });

  it("formats comments list", () => {
    const text = formatComments([makeComment()]);
    expect(text).toContain("john.doe");
    expect(text).toContain("Chrome 120");
  });
});
