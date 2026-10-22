import type {
  CodebeamerClient,
  CbAccessPermission,
  CbRoleWithPermissions,
  CbTracker,
  CbTrackerBasicInformation,
  CbTrackerConfiguration,
  CbTrackerFieldConfig,
  CbTrackerSchemaField,
  CbWorkflowTransition,
} from "../client/codebeamer-client.js";
import { mapLimit } from "./concurrency.js";

// --- Loading ---

/** Raw configuration data of one tracker. Only the configuration itself is mandatory. */
export interface TrackerSnapshot {
  trackerId: number;
  config: CbTrackerConfiguration;
  schema: CbTrackerSchemaField[];
  tracker?: CbTracker;
  transitions?: CbWorkflowTransition[];
  permissions?: CbRoleWithPermissions[];
  /** Parts that could not be loaded, usually because the user's role lacks access. */
  warnings: string[];
}

export async function loadTrackerSnapshot(
  client: CodebeamerClient,
  trackerId: number,
  options: { transitions?: boolean; permissions?: boolean } = {},
): Promise<TrackerSnapshot> {
  const warnings: string[] = [];
  const optional = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`Tracker ${trackerId} ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const [config, schema, tracker, transitions, permissions] = await Promise.all([
    client.getTrackerConfiguration(trackerId),
    optional("schema", () => client.getTrackerSchema(trackerId)),
    optional("details", () => client.getTracker(trackerId)),
    options.transitions === false
      ? Promise.resolve(undefined)
      : optional("transitions", () => client.getTrackerTransitions(trackerId)),
    options.permissions
      ? optional("permissions", () => client.getTrackerPermissions(trackerId))
      : Promise.resolve(undefined),
  ]);

  return { trackerId, config, schema: schema ?? [], tracker, transitions, permissions, warnings };
}

/** Display names for reference-filter targets, keyed by `${domainType}:${domainId}`. */
export type ReferenceNames = Map<string, string>;

export async function resolveReferenceNames(
  client: CodebeamerClient,
  snapshots: TrackerSnapshot[],
): Promise<ReferenceNames> {
  const names: ReferenceNames = new Map();
  for (const s of snapshots) {
    const name = s.config.basicInformation?.name ?? s.tracker?.name;
    if (name) names.set(`TRACKER:${s.trackerId}`, name);
  }

  const wanted = new Map<string, { type: string; id: number }>();
  for (const s of snapshots) {
    for (const field of s.config.fields ?? []) {
      for (const ref of field.choiceOptionSetting?.referenceFilters ?? []) {
        if (ref.domainId === undefined || !ref.domainType) continue;
        const key = `${ref.domainType}:${ref.domainId}`;
        if (!names.has(key)) wanted.set(key, { type: ref.domainType, id: ref.domainId });
      }
    }
  }

  await mapLimit([...wanted.entries()], 5, async ([key, { type, id }]) => {
    try {
      if (type === "TRACKER") names.set(key, (await client.getTracker(id)).name);
      else if (type === "PROJECT") names.set(key, (await client.getProject(id)).name);
    } catch {
      // Unresolvable targets (deleted or not visible to this user) are shown by ID.
    }
  });
  return names;
}

// --- Normalization ---

export interface NormalizedOption {
  id: number;
  name: string;
  meanings: string[];
  restrictedToStatuses: string[];
}

export interface NormalizedReference {
  domainType: string;
  domainId?: number;
  domainName?: string;
  targetIds: number[];
  filterId?: number;
}

export interface NormalizedField {
  id?: number;
  name: string;
  /** Built-in field identifier (e.g. "status", "assignedTo"); undefined for custom fields. */
  builtIn?: string;
  type?: string;
  isStatus: boolean;
  mandatory: boolean;
  mandatoryExceptIn: string[];
  mandatoryIf?: string;
  hidden: boolean;
  hideIf?: string;
  multiple: boolean;
  formula?: string;
  permission?: string;
  dependsOn?: string;
  choiceKind?: string;
  options?: NormalizedOption[];
  references?: NormalizedReference[];
}

export interface NormalizedTransition {
  id: number;
  name: string;
  from: string;
  to: string;
  hidden: boolean;
  allowed: string[];
}

export interface NormalizedTracker {
  id: number;
  name: string;
  key?: string;
  projectId?: number;
  projectName?: string;
  typeName?: string;
  template: boolean;
  templateId?: number;
  workflowActive?: boolean;
  basic: CbTrackerBasicInformation;
  fields: NormalizedField[];
  statuses: Array<{ id: number; name: string }>;
  transitions?: NormalizedTransition[];
  permissions?: Array<{ role: string; permissions: string[] }>;
  warnings: string[];
}

// Codebeamer numbers custom fields from 10000 in every tracker; lower IDs are built-in fields.
const FIRST_CUSTOM_FIELD_ID = 10000;

function configFieldId(field: CbTrackerFieldConfig): number | undefined {
  if (typeof field.referenceId === "number") return field.referenceId;
  return typeof field.id === "number" ? field.id : undefined;
}

function isStatusSchemaField(field: CbTrackerSchemaField): boolean {
  return field.trackerItemField === "status" || field.legacyRestName === "status";
}

function describeAccess(permission: CbAccessPermission): string {
  const subject = permission.role
    ? `role ${permission.role.name}`
    : permission.field
      ? `field ${permission.field.name}`
      : permission.project
        ? `project ${permission.project.name}`
        : "?";
  return permission.accessLevel ? `${subject} (${permission.accessLevel})` : subject;
}

export function normalizeTracker(
  snapshot: TrackerSnapshot,
  names: ReferenceNames = new Map(),
): NormalizedTracker {
  const basic = snapshot.config.basicInformation ?? {};
  const schemaById = new Map(snapshot.schema.map((f) => [f.id, f]));
  const configFields = [...(snapshot.config.fields ?? [])].sort(
    (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
  );

  const schemaFor = (f: CbTrackerFieldConfig) => {
    const id = configFieldId(f);
    return id === undefined ? undefined : schemaById.get(id);
  };
  const nameOf = (f: CbTrackerFieldConfig) => {
    const id = configFieldId(f);
    return schemaFor(f)?.name ?? f.label ?? f.title ?? `#${id ?? "?"}`;
  };
  const isStatusField = (f: CbTrackerFieldConfig) => {
    const sf = schemaFor(f);
    return sf ? isStatusSchemaField(sf) : /^status$/i.test(f.label ?? f.title ?? "");
  };

  const statusConfig = configFields.find(isStatusField);
  let statuses = (statusConfig?.choiceOptionSetting?.choiceOptions ?? []).map((o) => ({ id: o.id, name: o.name }));
  if (statuses.length === 0) {
    statuses = (snapshot.schema.find(isStatusSchemaField)?.options ?? []).map((o) => ({ id: o.id, name: o.name }));
  }
  const statusName = (id: number) => statuses.find((s) => s.id === id)?.name ?? `#${id}`;
  const fieldNames = new Map<number, string>();
  for (const f of configFields) {
    const id = configFieldId(f);
    if (id !== undefined) fieldNames.set(id, nameOf(f));
  }

  const fields: NormalizedField[] = configFields.map((f) => {
    const id = configFieldId(f);
    const sf = schemaFor(f);
    const setting = f.choiceOptionSetting;
    const builtIn = id !== undefined && id < FIRST_CUSTOM_FIELD_ID ? (sf?.trackerItemField ?? sf?.legacyRestName) : undefined;
    const dependentId = f.dependency?.dependentFieldId;
    return {
      id,
      name: nameOf(f),
      builtIn,
      type: sf?.type ?? (f.typeId !== undefined ? `typeId ${f.typeId}` : undefined),
      isStatus: isStatusField(f),
      mandatory: f.mandatory === true,
      mandatoryExceptIn: (f.mandatoryExceptInStatus ?? []).map(statusName),
      mandatoryIf: f.mandatoryIfFormula || undefined,
      hidden: f.hidden === true,
      hideIf: f.hideIfFormula || undefined,
      multiple: f.multipleSelection === true,
      formula: f.computedAs || undefined,
      permission: f.permission?.type,
      dependsOn: dependentId !== undefined ? (fieldNames.get(dependentId) ?? `#${dependentId}`) : undefined,
      choiceKind: setting?.type,
      options: setting?.choiceOptions?.map((o) => ({
        id: o.id,
        name: o.name,
        meanings: o.meanings ?? [],
        restrictedToStatuses: (o.restrictedToStatuses ?? []).map(statusName),
      })),
      references: setting?.referenceFilters?.map((r) => ({
        domainType: r.domainType ?? "?",
        domainId: r.domainId,
        domainName: names.get(`${r.domainType}:${r.domainId}`),
        targetIds: r.targetIds ?? [],
        filterId: r.filterId,
      })),
    };
  });

  const transitions = snapshot.transitions?.map((t) => ({
    id: t.id,
    name: t.name ?? "",
    from: t.fromStatus ? (t.fromStatus.name ?? statusName(t.fromStatus.id)) : "(initial)",
    to: t.toStatus ? (t.toStatus.name ?? statusName(t.toStatus.id)) : "?",
    hidden: t.hidden === true,
    allowed: (t.permissions ?? []).map(describeAccess).sort(),
  }));

  const permissions = snapshot.permissions?.map((rp) => ({
    role: rp.role?.name ?? `#${rp.role?.id ?? "?"}`,
    permissions: (rp.trackerPermissions ?? []).map((p) => p.name).sort(),
  }));

  return {
    id: snapshot.trackerId,
    name: basic.name ?? snapshot.tracker?.name ?? `Tracker ${snapshot.trackerId}`,
    key: basic.key ?? snapshot.tracker?.keyName,
    projectId: basic.projectId ?? snapshot.tracker?.project?.id,
    projectName: snapshot.tracker?.project?.name,
    typeName: snapshot.tracker?.type?.name,
    template: basic.template === true,
    templateId: basic.templateId || undefined,
    workflowActive: basic.workflowIsActive,
    basic,
    fields,
    statuses,
    transitions,
    permissions,
    warnings: snapshot.warnings,
  };
}

export function describeReference(ref: NormalizedReference): string {
  const kind = ref.domainType === "TRACKER" ? "tracker" : ref.domainType === "PROJECT" ? "project" : ref.domainType;
  const target = ref.domainName ? `"${ref.domainName}" [${ref.domainId}]` : `[${ref.domainId ?? "?"}]`;
  const extras = [
    ref.targetIds.length > 0 ? `targets ${ref.targetIds.join(",")}` : "",
    ref.filterId ? `filter ${ref.filterId}` : "",
  ].filter(Boolean);
  return `${kind} ${target}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
}

// Comparable across projects: uses the target's name when known, since IDs differ between projects.
function referenceKey(ref: NormalizedReference): string {
  const target = ref.domainName ?? `#${ref.domainId}`;
  const targets = ref.targetIds.length > 0 ? ` targets ${[...ref.targetIds].sort((a, b) => a - b).join(",")}` : "";
  return `${ref.domainType.toLowerCase()} ${target}${targets}`;
}

// --- Reference graph ---

export interface TrackerEdge {
  fromId: number;
  fromName: string;
  field: string;
  multiple: boolean;
  reference: NormalizedReference;
}

export function buildReferenceEdges(trackers: NormalizedTracker[]): TrackerEdge[] {
  return trackers.flatMap((t) =>
    t.fields.flatMap((f) =>
      (f.references ?? []).map((reference) => ({
        fromId: t.id,
        fromName: t.name,
        field: f.name,
        multiple: f.multiple,
        reference,
      })),
    ),
  );
}

function edgeKey(edge: TrackerEdge): string {
  return `${edge.fromName}.${edge.field} → ${referenceKey(edge.reference)}`;
}

export function diffEdges(a: TrackerEdge[], b: TrackerEdge[]): { onlyInA: string[]; onlyInB: string[] } {
  const keysA = new Set(a.map(edgeKey));
  const keysB = new Set(b.map(edgeKey));
  return {
    onlyInA: [...keysA].filter((k) => !keysB.has(k)).sort(),
    onlyInB: [...keysB].filter((k) => !keysA.has(k)).sort(),
  };
}

// --- Comparison ---

export interface ValueChange {
  property: string;
  a: string;
  b: string;
}

export interface TrackerDiff {
  a: { id: number; name: string; projectName?: string };
  b: { id: number; name: string; projectName?: string };
  settings: ValueChange[];
  fieldsOnlyInA: string[];
  fieldsOnlyInB: string[];
  /** Unmatched fields that share ID and type, likely renamed. */
  possibleRenames: string[];
  fieldChanges: Array<{ field: string; changes: ValueChange[] }>;
  statusesOnlyInA: string[];
  statusesOnlyInB: string[];
  transitionsOnlyInA: string[];
  transitionsOnlyInB: string[];
  transitionChanges: Array<{ transition: string; changes: ValueChange[] }>;
  /** undefined when permissions were not loaded for both trackers. */
  permissions?: {
    rolesOnlyInA: string[];
    rolesOnlyInB: string[];
    changes: Array<{ role: string; onlyInA: string[]; onlyInB: string[] }>;
  };
  transitionsCompared: boolean;
}

// Identity settings always differ between two trackers and are not configuration differences.
const IGNORED_SETTINGS = new Set(["trackerId", "projectId", "inboxId", "templateId", "name", "key", "description"]);

const show = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
};
const list = (values: string[]): string => (values.length > 0 ? [...values].sort().join(", ") : "-");

function fieldMatchKey(field: NormalizedField): string {
  return field.builtIn ? `builtin:${field.builtIn}` : `name:${field.name.trim().toLowerCase()}`;
}

const FIELD_PROPERTIES: Array<[string, (f: NormalizedField) => string]> = [
  ["name", (f) => f.name],
  ["type", (f) => show(f.type)],
  ["mandatory", (f) => show(f.mandatory)],
  ["mandatory except in statuses", (f) => list(f.mandatoryExceptIn)],
  ["mandatory if", (f) => show(f.mandatoryIf)],
  ["hidden", (f) => show(f.hidden)],
  ["hide if", (f) => show(f.hideIf)],
  ["multiple values", (f) => show(f.multiple)],
  ["computed as", (f) => show(f.formula)],
  ["permission", (f) => show(f.permission)],
  ["depends on", (f) => show(f.dependsOn)],
  ["choice kind", (f) => show(f.choiceKind)],
  ["references", (f) => list((f.references ?? []).map(referenceKey))],
];

function compareFields(a: NormalizedField, b: NormalizedField): ValueChange[] {
  const changes: ValueChange[] = [];
  for (const [property, get] of FIELD_PROPERTIES) {
    const va = get(a);
    const vb = get(b);
    if (va !== vb) changes.push({ property, a: va, b: vb });
  }

  // Status options are reported in the statuses section instead.
  if (!a.isStatus && (a.options || b.options)) {
    const optsA = new Map((a.options ?? []).map((o) => [o.name.toLowerCase(), o]));
    const optsB = new Map((b.options ?? []).map((o) => [o.name.toLowerCase(), o]));
    const onlyA = [...optsA.values()].filter((o) => !optsB.has(o.name.toLowerCase())).map((o) => o.name);
    const onlyB = [...optsB.values()].filter((o) => !optsA.has(o.name.toLowerCase())).map((o) => o.name);
    if (onlyA.length > 0 || onlyB.length > 0) {
      changes.push({ property: "options (only on this side)", a: list(onlyA), b: list(onlyB) });
    }
    for (const [key, oa] of optsA) {
      const ob = optsB.get(key);
      if (!ob) continue;
      if (list(oa.restrictedToStatuses) !== list(ob.restrictedToStatuses)) {
        changes.push({
          property: `option "${oa.name}" restricted to statuses`,
          a: list(oa.restrictedToStatuses),
          b: list(ob.restrictedToStatuses),
        });
      }
      if (list(oa.meanings) !== list(ob.meanings)) {
        changes.push({ property: `option "${oa.name}" meanings`, a: list(oa.meanings), b: list(ob.meanings) });
      }
    }
  }
  return changes;
}

function transitionKeys(transitions: NormalizedTransition[]): Map<string, NormalizedTransition> {
  const counts = new Map<string, number>();
  for (const t of transitions) {
    const base = `${t.from} → ${t.to}`.toLowerCase();
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const keyed = new Map<string, NormalizedTransition>();
  for (const t of transitions) {
    const base = `${t.from} → ${t.to}`;
    // Several transitions between the same statuses are told apart by name.
    const key = (counts.get(base.toLowerCase()) ?? 0) > 1 ? `${base} "${t.name}"` : base;
    keyed.set(key.toLowerCase(), t);
  }
  return keyed;
}

function describeTransition(t: NormalizedTransition): string {
  return `${t.from} → ${t.to}${t.name ? ` ("${t.name}")` : ""}`;
}

export function compareTrackers(a: NormalizedTracker, b: NormalizedTracker): TrackerDiff {
  const settingKeys = new Set(
    [...Object.keys(a.basic), ...Object.keys(b.basic)].filter((k) => !IGNORED_SETTINGS.has(k)),
  );
  const settings: ValueChange[] = [];
  for (const key of [...settingKeys].sort()) {
    const va = a.basic[key];
    const vb = b.basic[key];
    if (typeof va === "object" || typeof vb === "object") continue;
    if (show(va) !== show(vb)) settings.push({ property: key, a: show(va), b: show(vb) });
  }
  if (show(a.typeName) !== show(b.typeName)) {
    settings.push({ property: "tracker type", a: show(a.typeName), b: show(b.typeName) });
  }

  const fieldsA = new Map(a.fields.map((f) => [fieldMatchKey(f), f]));
  const fieldsB = new Map(b.fields.map((f) => [fieldMatchKey(f), f]));
  const unmatchedA = [...fieldsA.entries()].filter(([k]) => !fieldsB.has(k)).map(([, f]) => f);
  const unmatchedB = [...fieldsB.entries()].filter(([k]) => !fieldsA.has(k)).map(([, f]) => f);
  const possibleRenames = unmatchedA.flatMap((fa) =>
    unmatchedB
      .filter((fb) => fa.id !== undefined && fa.id === fb.id && fa.type === fb.type)
      .map((fb) => `"${fa.name}" ↔ "${fb.name}" (field ID ${fa.id}, ${fa.type ?? "unknown type"})`),
  );
  const fieldChanges = [...fieldsA.entries()]
    .filter(([k]) => fieldsB.has(k))
    .map(([k, fa]) => ({ field: fa.name, changes: compareFields(fa, fieldsB.get(k)!) }))
    .filter((c) => c.changes.length > 0);

  const statusNamesA = new Set(a.statuses.map((s) => s.name.toLowerCase()));
  const statusNamesB = new Set(b.statuses.map((s) => s.name.toLowerCase()));

  const transitionsCompared = a.transitions !== undefined && b.transitions !== undefined;
  const transA = transitionKeys(a.transitions ?? []);
  const transB = transitionKeys(b.transitions ?? []);
  const transitionChanges: TrackerDiff["transitionChanges"] = [];
  for (const [key, ta] of transA) {
    const tb = transB.get(key);
    if (!tb) continue;
    const changes: ValueChange[] = [];
    if (ta.name !== tb.name) changes.push({ property: "name", a: show(ta.name), b: show(tb.name) });
    if (ta.hidden !== tb.hidden) changes.push({ property: "hidden", a: show(ta.hidden), b: show(tb.hidden) });
    if (list(ta.allowed) !== list(tb.allowed)) {
      changes.push({ property: "allowed for", a: list(ta.allowed), b: list(tb.allowed) });
    }
    if (changes.length > 0) transitionChanges.push({ transition: `${ta.from} → ${ta.to}`, changes });
  }

  let permissions: TrackerDiff["permissions"];
  if (a.permissions && b.permissions) {
    const rolesA = new Map(a.permissions.map((p) => [p.role.toLowerCase(), p]));
    const rolesB = new Map(b.permissions.map((p) => [p.role.toLowerCase(), p]));
    permissions = {
      rolesOnlyInA: [...rolesA.values()].filter((p) => !rolesB.has(p.role.toLowerCase())).map((p) => p.role),
      rolesOnlyInB: [...rolesB.values()].filter((p) => !rolesA.has(p.role.toLowerCase())).map((p) => p.role),
      changes: [...rolesA.entries()]
        .filter(([k]) => rolesB.has(k))
        .map(([k, pa]) => {
          const pb = rolesB.get(k)!;
          return {
            role: pa.role,
            onlyInA: pa.permissions.filter((p) => !pb.permissions.includes(p)),
            onlyInB: pb.permissions.filter((p) => !pa.permissions.includes(p)),
          };
        })
        .filter((c) => c.onlyInA.length > 0 || c.onlyInB.length > 0),
    };
  }

  return {
    a: { id: a.id, name: a.name, projectName: a.projectName },
    b: { id: b.id, name: b.name, projectName: b.projectName },
    settings,
    fieldsOnlyInA: unmatchedA.map((f) => f.name),
    fieldsOnlyInB: unmatchedB.map((f) => f.name),
    possibleRenames,
    fieldChanges,
    statusesOnlyInA: a.statuses.filter((s) => !statusNamesB.has(s.name.toLowerCase())).map((s) => s.name),
    statusesOnlyInB: b.statuses.filter((s) => !statusNamesA.has(s.name.toLowerCase())).map((s) => s.name),
    transitionsOnlyInA: [...transA.entries()].filter(([k]) => !transB.has(k)).map(([, t]) => describeTransition(t)),
    transitionsOnlyInB: [...transB.entries()].filter(([k]) => !transA.has(k)).map(([, t]) => describeTransition(t)),
    transitionChanges,
    permissions,
    transitionsCompared,
  };
}

export function countDifferences(diff: TrackerDiff): {
  settings: number;
  fields: number;
  statuses: number;
  transitions: number;
  permissions: number;
  total: number;
} {
  const fields = diff.fieldsOnlyInA.length + diff.fieldsOnlyInB.length + diff.fieldChanges.length;
  const statuses = diff.statusesOnlyInA.length + diff.statusesOnlyInB.length;
  const transitions =
    diff.transitionsOnlyInA.length + diff.transitionsOnlyInB.length + diff.transitionChanges.length;
  const permissions = diff.permissions
    ? diff.permissions.rolesOnlyInA.length + diff.permissions.rolesOnlyInB.length + diff.permissions.changes.length
    : 0;
  const settings = diff.settings.length;
  return { settings, fields, statuses, transitions, permissions, total: settings + fields + statuses + transitions + permissions };
}

/** Pair trackers of two projects by name (case-insensitive). */
export function matchTrackersByName<T extends { name: string }>(
  a: T[],
  b: T[],
): { pairs: Array<[T, T]>; onlyInA: T[]; onlyInB: T[] } {
  const byNameB = new Map(b.map((t) => [t.name.trim().toLowerCase(), t]));
  const matchedB = new Set<T>();
  const pairs: Array<[T, T]> = [];
  const onlyInA: T[] = [];
  for (const ta of a) {
    const tb = byNameB.get(ta.name.trim().toLowerCase());
    if (tb && !matchedB.has(tb)) {
      pairs.push([ta, tb]);
      matchedB.add(tb);
    } else {
      onlyInA.push(ta);
    }
  }
  return { pairs, onlyInA, onlyInB: b.filter((t) => !matchedB.has(t)) };
}
