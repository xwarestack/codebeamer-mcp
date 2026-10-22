import { describe, it, expect } from "vitest";
import {
  buildReferenceEdges,
  describeReference,
  emptyLookups,
  expandTypeReferences,
  normalizeTracker,
  typeReferenceProjects,
  type TrackerSnapshot,
} from "../../../src/analysis/tracker-config.js";
import { formatTrackerGraph, formatWorkflow } from "../../../src/formatters/config-formatter.js";

// Shapes observed on a real Codebeamer instance (Test Run tracker of a QA project).

const lookups = emptyLookups();
lookups.roles.set(5, "Developer").set(6, "Tester").set(69, "Project Manager");
lookups.trackerTypes.set(108, "Test Set").set(150, "Team");
lookups.targets.set("PROJECT:154", { name: "Yoshi-QA" });
lookups.targets.set("PROJECT:66", { name: "AISIN Manpower" });

const snapshot: TrackerSnapshot = {
  trackerId: 656911,
  warnings: [],
  config: {
    basicInformation: { trackerId: 656911, projectId: 154, name: "Test Runs" },
    fields: [
      {
        referenceId: 7,
        label: "Status",
        typeId: 6,
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [
            { id: 1, name: "In progress" },
            { id: 4, name: "Finished" },
          ],
        },
      },
      {
        referenceId: 3,
        label: "Name",
        typeId: 0,
        permission: {
          type: "PER_STATUS",
          accessPermissionsPerStatusMap: {
            // Non-numeric key: rules for items without a status yet.
            null: [
              { subjectType: "FIELD", subjectId: 5, access: "READ_WRITE" },
              { subjectType: "ROLE", subjectId: 5, access: "READ" },
              { subjectType: "ROLE", subjectId: 6, access: "READ" },
            ],
            "4": [],
          },
        },
      },
      { referenceId: 5, label: "Assigned to", typeId: 5 },
      {
        referenceId: 17,
        label: "Test Set",
        typeId: 7,
        choiceOptionSetting: {
          type: "CHOICE_TRACKERS",
          referenceFilters: [{ domainType: "PROJECT", domainId: 154, targetIds: [108] }],
        },
      },
      {
        referenceId: 21,
        label: '<font color="green">Team</font>',
        typeId: 7,
        choiceOptionSetting: {
          type: "CHOICE_TRACKERS",
          referenceFilters: [{ domainType: "PROJECT", domainId: 66, targetIds: [150] }],
        },
      },
      {
        referenceId: 10003,
        label: "Project Manager",
        typeId: 5,
        choiceOptionSetting: {
          type: "CHOICE_USERS",
          referenceFilters: [{ domainType: "PROJECT", domainId: 154, targetIds: [69] }],
        },
      },
      { referenceId: 10004, label: "Impacted Projects", typeId: 8, choiceOptionSetting: { type: "CHOICE_PROJECTS", referenceFilters: [{}] } },
      { referenceId: 1000000, label: "Test Cases", typeId: 12 },
      { referenceId: 1000001, label: "Test Case", typeId: 7 },
      { referenceId: 1000002, label: "Active", typeId: 4 },
      { referenceId: 10000, label: "Sequential", typeId: 4 },
    ],
  },
  schema: [
    { id: 7, name: "Status", type: "OptionChoiceField", legacyRestName: "status", trackerItemField: "status" },
    { id: 3, name: "Name", type: "TextField", legacyRestName: "name" },
    { id: 5, name: "Assigned to", type: "UserChoiceField", legacyRestName: "assignedTo" },
    { id: 17, name: "Test Set", type: "TrackerItemChoiceField" },
    { id: 21, name: '<font color="green">Team</font>', type: "TrackerItemChoiceField" },
    { id: 10003, name: "Project Manager", type: "UserChoiceField" },
    { id: 10004, name: "Impacted Projects", type: "ProjectChoiceField" },
    { id: 1000000, name: "Test Cases", type: "TableField" },
    { id: 10000, name: "Sequential", type: "BoolField" },
  ],
  transitions: [
    // Transition permissions carry only IDs; "Unset" (ID 0) is the state of a new item.
    {
      id: 1,
      name: "Start",
      fromStatus: { id: 0, name: "Unset" },
      toStatus: { id: 1, name: "In progress" },
      permissions: [{ role: { id: 6 } as never, accessLevel: "READ" }, { field: { id: 5 } as never, accessLevel: "READ" }],
    },
    { id: 2, name: "Finish", fromStatus: { id: 1, name: "In progress" }, toStatus: { id: 4, name: "Finished" } },
  ],
};

const tracker = normalizeTracker(snapshot, lookups);
const field = (name: string) => tracker.fields.find((f) => f.name === name)!;

describe("normalizing real-instance shapes", () => {
  it("labels the status-less permission column and groups grants by access level", () => {
    expect(field("Name").permission).toBe(
      "per status: (no status) (READ_WRITE: field Assigned to; READ: role Developer, role Tester) | Finished (none)",
    );
  });

  it("names table columns after their table and infers their type from other fields", () => {
    expect(field("Test Cases › Test Case").type).toBe("TrackerItemChoiceField");
    expect(field("Test Cases › Active").type).toBe("BoolField");
  });

  it("strips HTML from field labels", () => {
    expect(field("Team")).toBeDefined();
  });

  it("describes type, member and project references", () => {
    expect(describeReference(field("Test Set").references![0])).toBe('trackers of type "Test Set" in own project');
    expect(describeReference(field("Team").references![0])).toBe('trackers of type "Team" in project "AISIN Manpower" [66]');
    expect(field("Project Manager").references![0].kind).toBe("members");
    expect(describeReference(field("Project Manager").references![0])).toBe(
      'members with role "Project Manager" of own project',
    );
    expect(describeReference(field("Impacted Projects").references![0])).toBe("any project");
  });

  it("resolves transition subjects by ID and treats Unset as the initial state", () => {
    expect(tracker.transitions![0]).toMatchObject({
      from: "(initial)",
      to: "In progress",
      allowed: ["field Assigned to (READ)", "role Tester (READ)"],
    });
    expect(formatWorkflow(tracker)).toContain("[*] --> s0 : Start");
  });
});

describe("reference graph on real-instance shapes", () => {
  const edges = buildReferenceEdges([tracker]);

  it("only links tracker-item references", () => {
    // "Project Manager" (members) and "Impacted Projects" (projects) are not tracker links.
    expect(edges.map((e) => e.field).sort()).toEqual(["Team", "Test Set"]);
    expect(typeReferenceProjects(edges).sort()).toEqual([154, 66].sort());
  });

  it("expands type references to the trackers of the referenced projects", () => {
    const expanded = expandTypeReferences(
      edges,
      new Map([
        [154, [{ id: 700, name: "Test Sets", type: { id: 108 } }]],
        [66, [{ id: 228242, name: "Team", type: { id: 150 } }]],
      ]),
    );
    expect(expanded.map((e) => describeReference(e.reference)).sort()).toEqual([
      'tracker "Team" [228242] in project AISIN Manpower',
      'tracker "Test Sets" [700]',
    ]);

    const text = formatTrackerGraph("Graph", [tracker], expanded, []);
    expect(text).toContain('["Team (AISIN Manpower)"]');
  });

  it("merges parallel arrows into one labelled with every field", () => {
    const twice = [...edges, { ...edges[0], field: "Other Set" }];
    const text = formatTrackerGraph("Graph", [tracker], twice, []);
    expect(text).toContain('-->|"Test Set, Other Set"|');
  });
});
