import type {
  CbRoleWithPermissions,
  CbTrackerConfiguration,
  CbTrackerSchemaField,
  CbWorkflowTransition,
} from "../../../src/client/codebeamer-client.js";

// Tracker 900 is a template, tracker 901 ("Requirements" in project 2) is derived from it with local changes.
// Both reference tracker 902 through the custom "Verifies" field.

const statusOptions = [
  { id: 1, name: "New" },
  { id: 2, name: "In Progress" },
  { id: 3, name: "Done" },
];

export const configurations: Record<number, CbTrackerConfiguration> = {
  900: {
    basicInformation: {
      trackerId: 900,
      projectId: 1,
      name: "Requirements",
      key: "REQ",
      template: true,
      workflowIsActive: true,
      locked: false,
      defaultLayout: "DOCUMENT",
    },
    fields: [
      { referenceId: 3, label: "Summary", typeId: 0, mandatory: true, position: 1, permission: { type: "UNRESTRICTED" } },
      {
        referenceId: 7,
        label: "Status",
        typeId: 6,
        mandatory: true,
        position: 2,
        choiceOptionSetting: { type: "CHOICE_OPTIONS", choiceOptions: statusOptions },
      },
      {
        referenceId: 2,
        label: "Priority",
        typeId: 6,
        position: 3,
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [
            { id: 1, name: "High" },
            { id: 2, name: "Low", restrictedToStatuses: [1] },
          ],
        },
      },
      {
        referenceId: 10000,
        label: "Verifies",
        typeId: 9,
        multipleSelection: true,
        position: 4,
        choiceOptionSetting: {
          type: "CHOICE_TRACKERS",
          referenceFilters: [{ id: 1, domainType: "TRACKER", domainId: 902 }],
        },
      },
      {
        referenceId: 10001,
        label: "Safety Level",
        typeId: 6,
        position: 5,
        computedAs: "",
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [
            { id: 1, name: "ASIL A" },
            { id: 2, name: "ASIL B" },
          ],
        },
      },
    ],
  },
  901: {
    basicInformation: {
      trackerId: 901,
      projectId: 2,
      name: "Requirements",
      key: "REQ2",
      template: false,
      templateId: 900,
      workflowIsActive: true,
      locked: true,
      defaultLayout: "DOCUMENT",
    },
    fields: [
      { referenceId: 3, label: "Summary", typeId: 0, mandatory: false, position: 1, permission: { type: "UNRESTRICTED" } },
      {
        referenceId: 7,
        label: "Status",
        typeId: 6,
        mandatory: true,
        position: 2,
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [...statusOptions, { id: 4, name: "Rejected" }],
        },
      },
      {
        referenceId: 2,
        label: "Priority",
        typeId: 6,
        position: 3,
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [
            { id: 1, name: "High" },
            { id: 2, name: "Low" },
            { id: 3, name: "Medium" },
          ],
        },
      },
      {
        referenceId: 10000,
        label: "Verifies",
        typeId: 9,
        multipleSelection: true,
        position: 4,
        choiceOptionSetting: {
          type: "CHOICE_TRACKERS",
          referenceFilters: [{ id: 1, domainType: "TRACKER", domainId: 902 }],
        },
      },
      {
        referenceId: 10001,
        label: "Safety Class",
        typeId: 6,
        position: 5,
        choiceOptionSetting: {
          type: "CHOICE_OPTIONS",
          choiceOptions: [
            { id: 1, name: "ASIL A" },
            { id: 2, name: "ASIL B" },
          ],
        },
      },
      { referenceId: 10002, label: "Customer", typeId: 0, position: 6, hideIfFormula: "status.id == 4" },
    ],
  },
};

function schemaFor(config: CbTrackerConfiguration): CbTrackerSchemaField[] {
  const builtIn: Record<number, { legacyRestName: string; type: string }> = {
    3: { legacyRestName: "name", type: "TextField" },
    7: { legacyRestName: "status", type: "OptionChoiceField" },
    2: { legacyRestName: "priority", type: "OptionChoiceField" },
  };
  return (config.fields ?? []).map((f) => {
    const id = f.referenceId!;
    const known = builtIn[id];
    return {
      id,
      name: f.label!,
      type: known?.type ?? (f.choiceOptionSetting?.referenceFilters ? "TrackerItemChoiceField" : f.choiceOptionSetting ? "OptionChoiceField" : "TextField"),
      legacyRestName: known?.legacyRestName ?? `customField[${id - 10000}]`,
      trackerItemField: known?.legacyRestName,
    };
  });
}

export const schemas: Record<number, CbTrackerSchemaField[]> = {
  900: schemaFor(configurations[900]),
  901: schemaFor(configurations[901]),
};

const ref = (id: number, name: string) => ({ id, name, type: "ChoiceOptionReference" });
const developer = { id: 5, name: "Developer", type: "RoleReference" };
const reviewer = { id: 6, name: "Reviewer", type: "RoleReference" };

export const transitions: Record<number, CbWorkflowTransition[]> = {
  900: [
    { id: 11, name: "Start", fromStatus: ref(1, "New"), toStatus: ref(2, "In Progress"), permissions: [{ role: developer }] },
    { id: 12, name: "Finish", fromStatus: ref(2, "In Progress"), toStatus: ref(3, "Done"), permissions: [{ role: reviewer }] },
  ],
  901: [
    { id: 21, name: "Begin", fromStatus: ref(1, "New"), toStatus: ref(2, "In Progress"), permissions: [{ role: developer }] },
    { id: 22, name: "Finish", fromStatus: ref(2, "In Progress"), toStatus: ref(3, "Done"), permissions: [{ role: developer }] },
    { id: 23, name: "Reject", fromStatus: ref(2, "In Progress"), toStatus: ref(4, "Rejected"), hidden: true },
  ],
};

const perm = (id: number, name: string) => ({ id, name, type: "TrackerPermissionReference" });

export const permissions: Record<number, CbRoleWithPermissions[]> = {
  900: [
    { role: developer, trackerPermissions: [perm(1, "Item - View"), perm(2, "Item - Edit")] },
    { role: reviewer, trackerPermissions: [perm(1, "Item - View")] },
  ],
  901: [{ role: developer, trackerPermissions: [perm(1, "Item - View")] }],
};
