import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/client/http-client.js";
import { CodebeamerClient } from "../../../src/client/codebeamer-client.js";
import {
  formatReferenceTable,
  formatTrackerPermissions,
} from "../../../src/formatters/config-formatter.js";
import { formatUserSearch } from "../../../src/formatters/user-formatter.js";

const BASE = "https://test-cb.example.com/v3";

function makeClient() {
  return new CodebeamerClient(new HttpClient({ baseUrl: BASE, username: "testuser", password: "testpass" }));
}

describe("get_tracker_permissions", () => {
  it("lists permissions per role", async () => {
    const text = formatTrackerPermissions(900, await makeClient().getTrackerPermissions(900));

    expect(text).toContain("(2 roles)");
    expect(text).toContain("| Developer | Item - Edit, Item - View |");
  });

  it("passes the role filter to the API", async () => {
    const permissions = await makeClient().getTrackerPermissions(900, { roleId: 6 });
    expect(permissions.map((p) => p.role?.name)).toEqual(["Reviewer"]);
  });
});

describe("reference lists", () => {
  it("lists tracker types, roles and association types", async () => {
    const client = makeClient();

    expect(formatReferenceTable("Tracker types", await client.listTrackerTypes())).toContain("| 1 | Requirement |");
    expect(formatReferenceTable("Roles", await client.listRoles())).toContain("| 6 | Reviewer |");
    expect(formatReferenceTable("Association types", await client.listAssociationTypes())).toContain(
      "| 4 | related | Related to |",
    );
  });

  it("reads paginated project members", async () => {
    const result = await makeClient().getProjectMembers(1, 1, 100);

    expect(result.total).toBe(2);
    expect(formatReferenceTable("Members", result.items)).toContain("| 9 | QA Team |");
  });
});

describe("find_user", () => {
  it("searches users by name", async () => {
    const result = await makeClient().searchUsers("john", 1, 25);
    expect(formatUserSearch("john", result, 1, 25)).toContain("| 5 | john.doe |");
  });

  it("looks users up by email", async () => {
    const user = await makeClient().findUserByEmail("jane@example.com");
    expect(user.email).toBe("jane@example.com");
  });
});
