import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mockServer } from "../../setup.js";
import { HttpClient } from "../../../src/client/http-client.js";
import { CodebeamerClient } from "../../../src/client/codebeamer-client.js";
import {
  buildReferenceEdges,
  compareTrackers,
  countDifferences,
  diffEdges,
  loadTrackerSnapshot,
  matchTrackersByName,
  normalizeTracker,
  resolveLookups,
} from "../../../src/analysis/tracker-config.js";
import {
  formatTrackerConfiguration,
  formatTrackerDiff,
  formatTrackerGraph,
  formatWorkflow,
} from "../../../src/formatters/config-formatter.js";

const BASE = "https://test-cb.example.com/v3";

function makeClient() {
  return new CodebeamerClient(new HttpClient({ baseUrl: BASE, username: "testuser", password: "testpass" }));
}

async function load(trackerId: number, options = { transitions: true, permissions: true }) {
  const client = makeClient();
  const snapshot = await loadTrackerSnapshot(client, trackerId, options);
  const names = await resolveLookups(client, [snapshot]);
  return normalizeTracker(snapshot, names);
}

describe("normalizeTracker", () => {
  it("joins configuration with schema names, types and statuses", async () => {
    const t = await load(900);

    expect(t.name).toBe("Requirements");
    expect(t.template).toBe(true);
    expect(t.statuses.map((s) => s.name)).toEqual(["New", "In Progress", "Done"]);

    const status = t.fields.find((f) => f.name === "Status")!;
    expect(status.isStatus).toBe(true);
    expect(status.builtIn).toBe("status");

    const priority = t.fields.find((f) => f.name === "Priority")!;
    expect(priority.options?.find((o) => o.name === "Low")?.restrictedToStatuses).toEqual(["New"]);
    expect(priority.options?.find((o) => o.name === "High")?.defaultInStatuses).toEqual(["New"]);
    expect(priority.dependsOn).toBe("Status");
    expect(priority.dependencyValues).toBe("1 → 1,2");

    // Role IDs in field permissions are resolved through /roles.
    expect(t.fields.find((f) => f.name === "Summary")!.permission).toBe("single: role Developer=READ_WRITE");

    const verifies = t.fields.find((f) => f.name === "Verifies")!;
    expect(verifies.builtIn).toBeUndefined();
    expect(verifies.type).toBe("TrackerItemChoiceField");
    expect(verifies.references?.[0]).toMatchObject({ domainType: "TRACKER", domainId: 902, domainName: "Bug Tracker" });
  });

  it("resolves transition and permission subjects", async () => {
    const t = await load(901);

    expect(t.templateId).toBe(900);
    expect(t.transitions?.map((tr) => `${tr.from}>${tr.to}`)).toEqual([
      "New>In Progress",
      "In Progress>Done",
      "In Progress>Rejected",
    ]);
    expect(t.transitions?.[0].allowed).toEqual(["role Developer"]);
    expect(t.permissions).toEqual([{ role: "Developer", permissions: ["Item - View"] }]);
  });

  it("keeps working when optional parts are forbidden for the user's role", async () => {
    mockServer.use(
      http.get(`${BASE}/trackers/:id/permissions`, () => HttpResponse.json({}, { status: 403 })),
    );
    const t = await load(900);

    expect(t.permissions).toBeUndefined();
    expect(t.warnings.join(" ")).toMatch(/permissions: Forbidden/);
  });

  it("fails when the configuration itself is not accessible", async () => {
    await expect(load(12345)).rejects.toThrow(/Not found: configuration of tracker 12345/);
  });
});

describe("compareTrackers (template 900 vs derived 901)", () => {
  it("finds field, option, status, transition and permission differences", async () => {
    const diff = compareTrackers(await load(900), await load(901));

    expect(diff.settings).toContainEqual({ property: "locked", a: "no", b: "yes" });
    expect(diff.settings).toContainEqual({ property: "template", a: "yes", b: "no" });
    expect(diff.settings.map((s) => s.property)).not.toContain("key");

    expect(diff.fieldsOnlyInA).toEqual(["Safety Level"]);
    expect(diff.fieldsOnlyInB).toEqual(["Safety Class", "Customer"]);
    expect(diff.possibleRenames[0]).toContain('"Safety Level" ↔ "Safety Class"');

    const summary = diff.fieldChanges.find((c) => c.field === "Summary")!;
    expect(summary.changes).toContainEqual({ property: "mandatory", a: "yes", b: "no" });
    expect(summary.changes).toContainEqual({
      property: "permission",
      a: "single: role Developer=READ_WRITE",
      b: "single: role Developer=READ",
    });

    const priority = diff.fieldChanges.find((c) => c.field === "Priority")!;
    expect(priority.changes).toContainEqual({ property: "options (only on this side)", a: "-", b: "Medium" });
    expect(priority.changes).toContainEqual({ property: 'option "Low" restricted to statuses', a: "New", b: "-" });
    expect(priority.changes).toContainEqual({ property: 'option "High" default in statuses', a: "New", b: "-" });
    expect(priority.changes).toContainEqual({ property: 'option "Low" default in statuses', a: "-", b: "New" });
    expect(priority.changes).toContainEqual({ property: "dependency values", a: "1 → 1,2", b: "1 → 1" });

    // Added/removed statuses are reported in the statuses section; metadata of shared statuses in the field.
    const status = diff.fieldChanges.find((c) => c.field === "Status")!;
    expect(status.changes).toEqual([{ property: 'option "Done" meanings', a: "RESOLVED", b: "CLOSED" }]);
    expect(diff.statusesOnlyInB).toEqual(["Rejected"]);

    // 901 lives in project 2 but still references tracker 902 of project 1.
    const verifies = diff.fieldChanges.find((c) => c.field === "Verifies")!;
    expect(verifies.changes).toEqual([
      {
        property: "references",
        a: "tracker Bug Tracker (own project)",
        b: "tracker Bug Tracker (project Demo Project)",
      },
    ]);

    expect(diff.transitionsOnlyInB).toEqual(['In Progress → Rejected ("Reject")']);
    expect(diff.transitionChanges).toContainEqual({
      transition: 'New → In Progress ("Start")',
      changes: [{ property: "name", a: "Start", b: "Begin" }],
    });
    expect(diff.transitionChanges).toContainEqual({
      transition: 'In Progress → Done ("Finish")',
      changes: [{ property: "allowed for", a: "role Reviewer", b: "role Developer" }],
    });

    expect(diff.permissions?.rolesOnlyInA).toEqual(["Reviewer"]);
    expect(diff.permissions?.changes).toEqual([{ role: "Developer", onlyInA: ["Item - Edit"], onlyInB: [] }]);
  });

  it("reports no differences for identical trackers", async () => {
    const t = await load(900);
    const diff = compareTrackers(t, t);

    expect(countDifferences(diff).total).toBe(0);
    expect(formatTrackerDiff(diff)).toContain("No differences found");
  });

  it("formats a readable report with labels", async () => {
    const text = formatTrackerDiff(compareTrackers(await load(900), await load(901)), { a: "Template", b: "Tracker" });

    expect(text).toContain('Template = "Requirements" [900]');
    expect(text).toContain("### Fields");
    expect(text).toContain("**Only in Tracker:**");
    expect(text).toContain("#### Priority");
    expect(text).toContain("### Role permissions");
  });

  it("marks transitions and permissions as not compared when they were not loaded", async () => {
    const options = { transitions: false, permissions: false };
    const diff = compareTrackers(await load(900, options), await load(901, options));

    expect(diff.transitionsCompared).toBe(false);
    expect(diff.permissions).toBeUndefined();
    expect(formatTrackerDiff(diff)).toContain("transitions not compared");
  });

  it("does not count transition differences when only one workflow could be loaded", async () => {
    const diff = compareTrackers(await load(900), await load(901, { transitions: false, permissions: true }));

    expect(diff.transitionsCompared).toBe(false);
    expect(countDifferences(diff).transitions).toBe(0);
  });

  it("matches parallel transitions by name before treating the rest as added or removed", async () => {
    const a = await load(900);
    const b = await load(900);
    const finish = { id: 1, name: "Finish", from: "New", to: "Done", hidden: false, allowed: ["role Developer"] };
    a.transitions = [finish];
    b.transitions = [
      { ...finish, allowed: ["role Reviewer"] },
      { ...finish, id: 2, name: "Fast finish" },
    ];

    const diff = compareTrackers(a, b);
    expect(diff.transitionsOnlyInA).toEqual([]);
    expect(diff.transitionsOnlyInB).toEqual(['New → Done ("Fast finish")']);
    expect(diff.transitionChanges).toEqual([
      {
        transition: 'New → Done ("Finish")',
        changes: [{ property: "allowed for", a: "role Developer", b: "role Reviewer" }],
      },
    ]);
  });

  it("detects reference filter changes", async () => {
    const a = await load(900);
    const b = await load(900);
    const verifies = b.fields.find((f) => f.name === "Verifies")!;
    verifies.references = [{ ...verifies.references![0], filterId: 77, targetPermissions: ["READ"] }];

    const change = compareTrackers(a, b).fieldChanges.find((c) => c.field === "Verifies")!;
    expect(change.changes[0].b).toContain("filter 77, permissions READ");
  });
});

describe("reference graph", () => {
  it("builds edges from reference fields and diffs them by name and project", async () => {
    const a = await load(900);
    const b = await load(901);
    const edges = buildReferenceEdges([a]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromId: 900, field: "Verifies", multiple: true });
    expect(diffEdges(edges, edges)).toEqual({ onlyInA: [], onlyInB: [] });
    expect(diffEdges(edges, buildReferenceEdges([b]))).toEqual({
      onlyInA: ["Requirements.Verifies → tracker Bug Tracker (own project)"],
      onlyInB: ["Requirements.Verifies → tracker Bug Tracker (project Demo Project)"],
    });

    const text = formatTrackerGraph("Graph", [a], edges, []);
    expect(text).toContain("flowchart LR");
    expect(text).toContain('-->|"Verifies"|');
    expect(text).toContain('tracker "Bug Tracker" [902]');
  });
});

describe("formatters", () => {
  it("formats configuration with fields, statuses and options", async () => {
    const text = formatTrackerConfiguration(await load(901), { includeOptions: true });

    expect(text).toContain("## Tracker configuration: Requirements [901]");
    expect(text).toContain("**Derived from template tracker:** 900");
    expect(text).toContain("| 10002 | Customer |");
    expect(text).toContain("hidden if: `status.id == 4`");
    expect(text).toContain("### Statuses (4)");
    expect(text).toContain("**Priority** (field 2)");
    expect(text).toContain("- [3] Medium");
  });

  it("formats the workflow with a state diagram", async () => {
    const text = formatWorkflow(await load(901));

    expect(text).toContain("### Transitions (3)");
    expect(text).toContain("| 23 | Reject | In Progress | Rejected | yes |");
    expect(text).toContain("stateDiagram-v2");
    expect(text).toContain('state "In Progress" as s1');
    expect(text).toContain("s1 --> s3 : Reject");
  });
});

describe("matchTrackersByName", () => {
  it("pairs trackers case-insensitively and lists the rest", () => {
    const result = matchTrackersByName(
      [{ name: "Requirements" }, { name: "Bugs" }],
      [{ name: "requirements " }, { name: "Test Cases" }],
    );

    expect(result.pairs).toHaveLength(1);
    expect(result.onlyInA.map((t) => t.name)).toEqual(["Bugs"]);
    expect(result.onlyInB.map((t) => t.name)).toEqual(["Test Cases"]);
  });
});
