import type {
  CodebeamerClient,
  CbAccessPermission,
  CbFieldAccessGrant,
  CbFieldPermission,
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

/** A reference-filter target (tracker or project) with the project it belongs to. */
export interface ReferenceTarget {
  name: string;
  projectId?: number;
  projectName?: string;
}

/** Names needed to make configurations readable and comparable across projects. */
export interface Lookups {
  /** Keyed by `${domainType}:${domainId}`. */
  targets: Map<string, ReferenceTarget>;
  roles: Map<number, string>;
  trackerTypes: Map<number, string>;
}

export function emptyLookups(): Lookups {
  return { targets: new Map(), roles: new Map(), trackerTypes: new Map() };
}

function hasRoleGrants(permission: CbFieldPermission | undefined): boolean {
  const grants = [
    ...(permission?.accessPermissions ?? []),
    ...Object.values(permission?.accessPermissionsPerStatusMap ?? {}).flat(),
  ];
  return grants.some((g) => g.subjectType === "ROLE");
}

/**
 * Fetches the names a set of snapshots needs to be readable and comparable: reference-filter
 * targets (trackers/projects), and — only where some filter or grant actually uses them — role
 * and tracker-type names. Lookups that cannot be fetched are simply left empty; rendering then
 * falls back to IDs.
 */
export async function resolveLookups(
  client: CodebeamerClient,
  snapshots: TrackerSnapshot[],
): Promise<Lookups> {
  const lookups = emptyLookups();
  for (const s of snapshots) {
    const name = s.config.basicInformation?.name ?? s.tracker?.name;
    if (name) {
      lookups.targets.set(`TRACKER:${s.trackerId}`, {
        name,
        projectId: s.config.basicInformation?.projectId ?? s.tracker?.project?.id,
        projectName: s.tracker?.project?.name,
      });
    }
  }

  const wanted = new Map<string, { type: string; id: number }>();
  let needsRoles = false;
  let needsTrackerTypes = false;
  for (const s of snapshots) {
    needsRoles ||= (s.transitions ?? []).some((t) => (t.permissions ?? []).some((p) => p.role && !p.role.name));
    const schemaById = new Map(s.schema.map((f) => [f.id, f]));
    for (const field of s.config.fields ?? []) {
      needsRoles ||= hasRoleGrants(field.permission);
      // Classify exactly as normalizeTracker does, so every filter normalized as "members" gets role names.
      const fieldId = configFieldId(field);
      const sf = fieldId === undefined ? undefined : schemaById.get(fieldId);
      const userChoice = referenceKind(field.choiceOptionSetting?.type, sf?.type) === "members";
      for (const ref of field.choiceOptionSetting?.referenceFilters ?? []) {
        // Member filters carry role IDs on every domain; PROJECT item filters carry tracker type
        // IDs. Other item filters' IDs have no lookup and render as a raw `targets` constraint.
        if ((ref.targetIds?.length ?? 0) > 0) {
          if (userChoice) needsRoles = true;
          else if (ref.domainType === "PROJECT") needsTrackerTypes = true;
        }
        if (ref.domainId === undefined || !ref.domainType) continue;
        const key = `${ref.domainType}:${ref.domainId}`;
        if (!lookups.targets.has(key)) wanted.set(key, { type: ref.domainType, id: ref.domainId });
      }
    }
  }

  await Promise.all([
    mapLimit([...wanted.entries()], 5, async ([key, { type, id }]) => {
      try {
        if (type === "TRACKER") {
          const tracker = await client.getTracker(id);
          lookups.targets.set(key, {
            name: tracker.name,
            projectId: tracker.project?.id,
            projectName: tracker.project?.name,
          });
        } else if (type === "PROJECT") {
          lookups.targets.set(key, { name: (await client.getProject(id)).name });
        }
      } catch {
        // Unresolvable targets (deleted or not visible to this user) are shown by ID.
      }
    }),
    needsRoles
      ? client
          .listRoles()
          .then((roles) => roles.forEach((r) => lookups.roles.set(r.id, r.name)))
          .catch(() => undefined)
      : Promise.resolve(),
    needsTrackerTypes
      ? client
          .listTrackerTypes()
          .then((types) => types.forEach((t) => lookups.trackerTypes.set(t.id, t.name)))
          .catch(() => undefined)
      : Promise.resolve(),
  ]);
  return lookups;
}

// --- Normalization ---

export interface NormalizedOption {
  id: number;
  name: string;
  meanings: string[];
  restrictedToStatuses: string[];
  defaultInStatuses: string[];
}

/**
 * One reference-filter of a reference field. Codebeamer uses two forms:
 * - TRACKER: items of the tracker `domainId`;
 * - PROJECT: for item references, items of every tracker in project `domainId` whose tracker type is in
 *   `targetIds`; for user/member fields, members of project `domainId` with a role in `targetIds`.
 */
export interface NormalizedReference {
  /** What the field selects: tracker items, project members (users/groups), or projects. */
  kind: "items" | "members" | "projects";
  domainType: string;
  domainId?: number;
  domainName?: string;
  /** Project of a referenced tracker. */
  targetProjectName?: string;
  /** Whether the target tracker or project is the referencing tracker's own project; undefined if unknown. */
  ownProject?: boolean;
  /** Tracker type IDs (item references) or role IDs (member references). */
  targetIds: number[];
  /** Names of `targetIds`: role names (member filters) or tracker type names (PROJECT item filters).
   * Empty when the IDs' meaning is unknown; they then render as a raw `targets` constraint. */
  targetTypeNames: string[];
  filterId?: number;
  filterStatusId?: number;
  targetPermissions: string[];
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
  /** Field access rules with roles, user fields and statuses resolved to names. */
  permission?: string;
  dependsOn?: string;
  /** Allowed value combinations of the dependency, as `controlling value → allowed values`. */
  dependencyValues?: string;
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
// Table fields take IDs n * 1000000 and their columns n * 1000000 + 1, + 2, ...
const TABLE_ID_STEP = 1000000;

const ACCESS_ORDER = ["READ_WRITE", "READ", "NONE"];

function configFieldId(field: CbTrackerFieldConfig): number | undefined {
  if (typeof field.referenceId === "number") return field.referenceId;
  return typeof field.id === "number" ? field.id : undefined;
}

function isStatusSchemaField(field: CbTrackerSchemaField): boolean {
  return field.trackerItemField === "status" || field.legacyRestName === "status";
}

// Transition permissions often carry only the ID of the role or field, so names are resolved here.
function describeAccess(
  permission: CbAccessPermission,
  roleName: (id: number) => string,
  fieldName: (id: number) => string,
): string {
  const subject = permission.role
    ? `role ${permission.role.name ?? roleName(permission.role.id)}`
    : permission.field
      ? `field ${permission.field.name ?? fieldName(permission.field.id)}`
      : permission.project
        ? `project ${permission.project.name ?? `#${permission.project.id}`}`
        : "?";
  return permission.accessLevel ? `${subject} (${permission.accessLevel})` : subject;
}

// The choice setting type (CHOICE_USERS, MEMBERS, CHOICE_PROJECTS, ...) or, if missing, the field's schema
// type tells what a reference field selects.
function referenceKind(settingType: string | undefined, fieldType: string | undefined): NormalizedReference["kind"] {
  const hint = `${settingType ?? ""} ${fieldType ?? ""}`;
  if (/USER|MEMBER/i.test(hint)) return "members";
  if (/PROJECT/i.test(hint)) return "projects";
  return "items";
}

// Codebeamer models "new item" as the pseudo status "Unset" (ID 0) in transitions.
function isInitialStatus(status: { id: number; name?: string } | undefined): boolean {
  return !status || status.id === 0 || /^unset$/i.test(status.name ?? "");
}

function describeFieldPermission(
  permission: CbFieldPermission | undefined,
  roleName: (id: number) => string,
  fieldName: (id: number) => string,
  statusName: (id: number) => string,
): string | undefined {
  if (!permission) return undefined;
  // Grouped by access level, e.g. "READ_WRITE: field Assigned to, role Tester; READ: role Developer".
  const grants = (list: CbFieldAccessGrant[]) => {
    const byAccess = new Map<string, string[]>();
    for (const g of list) {
      const id = g.subjectId ?? -1;
      const subject = g.subjectType === "ROLE" ? `role ${roleName(id)}` : `field ${fieldName(id)}`;
      const access = g.access ?? "?";
      byAccess.set(access, [...(byAccess.get(access) ?? []), subject]);
    }
    if (byAccess.size === 0) return "none";
    return [...byAccess.entries()]
      .sort(([a], [b]) => ACCESS_ORDER.indexOf(a) - ACCESS_ORDER.indexOf(b) || a.localeCompare(b))
      .map(([access, subjects]) => `${access}: ${subjects.sort().join(", ")}`)
      .join("; ");
  };

  // The discriminator values vary between versions, so the variant is recognized by its data.
  if (permission.accessPermissionsPerStatusMap) {
    const perStatus = Object.entries(permission.accessPermissionsPerStatusMap)
      .map(([status, list]) => {
        // The non-numeric key holds the rules for items without a status yet (while being created).
        const id = Number(status);
        return `${Number.isFinite(id) ? statusName(id) : "(no status)"} (${grants(list)})`;
      })
      .sort()
      .join(" | ");
    return `per status: ${perStatus || "none"}`;
  }
  if (permission.accessPermissions) return `single (${grants(permission.accessPermissions)})`;
  if (permission.sameAsId !== undefined) return `same as ${fieldName(permission.sameAsId)}`;
  return permission.type?.toLowerCase();
}

export function normalizeTracker(snapshot: TrackerSnapshot, lookups: Lookups = emptyLookups()): NormalizedTracker {
  const basic = snapshot.config.basicInformation ?? {};
  const projectId = basic.projectId ?? snapshot.tracker?.project?.id;
  const schemaById = new Map(snapshot.schema.map((f) => [f.id, f]));
  const configFields = [...(snapshot.config.fields ?? [])].sort(
    (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
  );

  const schemaFor = (f: CbTrackerFieldConfig) => {
    const id = configFieldId(f);
    return id === undefined ? undefined : schemaById.get(id);
  };
  // Labels may contain HTML markup (e.g. <font color="green">Team</font>), which would break tables,
  // diagrams and name matching.
  const ownName = (f: CbTrackerFieldConfig) => {
    const id = configFieldId(f);
    const raw = schemaFor(f)?.name ?? f.label ?? f.title ?? `#${id ?? "?"}`;
    return raw.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || `#${id ?? "?"}`;
  };
  const tableNames = new Map<number, string>();
  for (const f of configFields) {
    const id = configFieldId(f);
    if (id !== undefined && id >= TABLE_ID_STEP && id % TABLE_ID_STEP === 0) tableNames.set(id, ownName(f));
  }
  // Table columns are named "Table › Column" so they stay recognizable and comparable.
  const nameOf = (f: CbTrackerFieldConfig) => {
    const id = configFieldId(f);
    const table = id !== undefined && id % TABLE_ID_STEP !== 0 ? tableNames.get(id - (id % TABLE_ID_STEP)) : undefined;
    return table ? `${table} › ${ownName(f)}` : ownName(f);
  };
  // Table columns are missing from the schema; name their numeric typeId after fields of the same typeId.
  const typeNames = new Map<number, string>();
  for (const f of configFields) {
    const type = schemaFor(f)?.type;
    if (type && f.typeId !== undefined && !typeNames.has(f.typeId)) typeNames.set(f.typeId, type);
  }
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
  const fieldName = (id: number) => fieldNames.get(id) ?? `#${id}`;
  const roleName = (id: number) => lookups.roles.get(id) ?? `#${id}`;

  const fields: NormalizedField[] = configFields.map((f) => {
    const id = configFieldId(f);
    const sf = schemaFor(f);
    const setting = f.choiceOptionSetting;
    const builtIn = id !== undefined && id < FIRST_CUSTOM_FIELD_ID ? (sf?.trackerItemField ?? sf?.legacyRestName) : undefined;
    const dependentId = f.dependency?.dependentFieldId;
    const combinations = Object.entries(f.dependency?.valueCombinations ?? {});
    return {
      id,
      name: nameOf(f),
      builtIn,
      type: sf?.type ?? (f.typeId !== undefined ? (typeNames.get(f.typeId) ?? `typeId ${f.typeId}`) : undefined),
      isStatus: isStatusField(f),
      mandatory: f.mandatory === true,
      mandatoryExceptIn: (f.mandatoryExceptInStatus ?? []).map(statusName),
      mandatoryIf: f.mandatoryIfFormula || undefined,
      hidden: f.hidden === true,
      hideIf: f.hideIfFormula || undefined,
      multiple: f.multipleSelection === true,
      formula: f.computedAs || undefined,
      permission: describeFieldPermission(f.permission, roleName, fieldName, statusName),
      dependsOn: dependentId !== undefined ? fieldName(dependentId) : undefined,
      dependencyValues:
        combinations.length > 0
          ? combinations
              .map(([value, allowed]) => `${value} → ${allowed}`)
              .sort()
              .join("; ")
          : undefined,
      choiceKind: setting?.type,
      options: setting?.choiceOptions?.map((o) => ({
        id: o.id,
        name: o.name,
        meanings: o.meanings ?? [],
        restrictedToStatuses: (o.restrictedToStatuses ?? []).map(statusName),
        defaultInStatuses: (o.defaultInStatuses ?? []).map(statusName),
      })),
      references: setting?.referenceFilters?.map((r) => {
        const target = lookups.targets.get(`${r.domainType}:${r.domainId}`);
        const ownProject =
          projectId === undefined
            ? undefined
            : r.domainType === "PROJECT"
              ? r.domainId === projectId
              : r.domainType === "TRACKER" && target?.projectId !== undefined
                ? target.projectId === projectId
                : undefined;
        const targetIds = r.targetIds ?? [];
        const kind = referenceKind(setting?.type, sf?.type);
        return {
          kind,
          domainType: r.domainType ?? "?",
          domainId: r.domainId,
          domainName: target?.name,
          targetProjectName: target?.projectName,
          ownProject,
          targetIds,
          targetTypeNames:
            kind === "members"
              ? targetIds.map((id) => lookups.roles.get(id) ?? `role #${id}`)
              : r.domainType === "PROJECT"
                ? targetIds.map((id) => lookups.trackerTypes.get(id) ?? `type #${id}`)
                : [],
          filterId: r.filterId,
          filterStatusId: r.filterStatusId,
          targetPermissions: [...(r.targetPermissions ?? [])].sort(),
        };
      }),
    };
  });

  const transitions = snapshot.transitions?.map((t) => ({
    id: t.id,
    name: t.name ?? "",
    from: isInitialStatus(t.fromStatus) ? "(initial)" : (t.fromStatus!.name ?? statusName(t.fromStatus!.id)),
    to: t.toStatus ? (t.toStatus.name ?? statusName(t.toStatus.id)) : "?",
    hidden: t.hidden === true,
    allowed: (t.permissions ?? []).map((p) => describeAccess(p, roleName, fieldName)).sort(),
  }));

  const permissions = snapshot.permissions?.map((rp) => ({
    role: rp.role?.name ?? `#${rp.role?.id ?? "?"}`,
    permissions: (rp.trackerPermissions ?? []).map((p) => p.name).sort(),
  }));

  return {
    id: snapshot.trackerId,
    name: basic.name ?? snapshot.tracker?.name ?? `Tracker ${snapshot.trackerId}`,
    key: basic.key ?? snapshot.tracker?.keyName,
    projectId,
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

/** Renders a filter's extra constraints (unresolved target IDs, filter, status, permissions) for both display and comparison keys. */
function referenceConstraints(ref: NormalizedReference): string {
  const constraints = [
    // Target IDs whose meaning is unknown (item filters on non-PROJECT domains) must still show,
    // so trackers whose filters differ only in them compare as different.
    ref.targetIds.length > 0 && ref.targetTypeNames.length === 0
      ? `targets ${[...ref.targetIds].sort((a, b) => a - b).join(",")}`
      : "",
    ref.filterId != null ? `filter ${ref.filterId}` : "",
    ref.filterStatusId != null ? `filter status ${ref.filterStatusId}` : "",
    ref.targetPermissions.length > 0 ? `permissions ${ref.targetPermissions.join(",")}` : "",
  ].filter(Boolean);
  return constraints.length > 0 ? ` (${constraints.join(", ")})` : "";
}

function typeList(ref: NormalizedReference): string {
  return [...ref.targetTypeNames].sort().map((n) => `"${n}"`).join(", ");
}

function anyTarget(ref: NormalizedReference): string {
  return ref.kind === "members" ? "any user" : ref.kind === "projects" ? "any project" : "any item";
}

/** Human-readable description of one reference filter, e.g. `trackers of type "Test Set" in own project`. */
export function describeReference(ref: NormalizedReference): string {
  const named = (kind: string) =>
    `${kind} ${ref.domainName ? `"${ref.domainName}" [${ref.domainId}]` : `[${ref.domainId ?? "?"}]`}`;
  let text: string;
  if (ref.domainId === undefined) {
    text = anyTarget(ref);
  } else if (ref.kind === "members") {
    const where = ref.domainType === "PROJECT" ? (ref.ownProject ? "own project" : named("project")) : named(ref.domainType.toLowerCase());
    text = ref.targetIds.length > 0 ? `members with role ${typeList(ref)} of ${where}` : `members of ${where}`;
  } else if (ref.kind === "projects") {
    text = named("project");
  } else if (ref.domainType === "PROJECT" && ref.targetIds.length > 0) {
    text = `trackers of type ${typeList(ref)} in ${ref.ownProject ? "own project" : named("project")}`;
  } else if (ref.domainType === "PROJECT") {
    text = ref.ownProject ? "any tracker in own project" : `any tracker in ${named("project")}`;
  } else if (ref.domainType === "TRACKER") {
    text = `${named("tracker")}${ref.ownProject === false ? ` in project ${ref.targetProjectName ?? "?"}` : ""}`;
  } else {
    text = named(ref.domainType.toLowerCase());
  }
  return `${text}${referenceConstraints(ref)}`;
}

// Comparable across projects: targets are identified by name plus whether they are in the referencing
// tracker's own project. Two projects set up alike compare equal, while a copied project that still
// points at the original project's tracker shows up as a difference. Exception: target IDs with no
// known name (the raw `targets` constraint) compare verbatim and may flag copies whose local IDs
// differ — preferred over hiding a possible difference entirely.
function referenceKey(ref: NormalizedReference): string {
  const project = (name: string | undefined) => (ref.ownProject ? "own project" : `project ${name ?? `#${ref.domainId}`}`);
  let key: string;
  if (ref.domainId === undefined) {
    key = anyTarget(ref);
  } else if (ref.kind === "members") {
    key = `members${ref.targetIds.length > 0 ? ` with role ${typeList(ref)}` : ""} of ${ref.domainType === "PROJECT" ? project(ref.domainName) : `${ref.domainType.toLowerCase()} ${ref.domainName ?? `#${ref.domainId}`}`}`;
  } else if (ref.kind === "projects") {
    key = project(ref.domainName);
  } else if (ref.domainType === "PROJECT") {
    key = `${ref.targetIds.length > 0 ? `type ${typeList(ref)}` : "any tracker"} in ${project(ref.domainName)}`;
  } else if (ref.domainType === "TRACKER") {
    const where = ref.ownProject === true ? " (own project)" : ref.ownProject === false ? ` (${project(ref.targetProjectName)})` : "";
    key = `tracker ${ref.domainName ?? `#${ref.domainId}`}${where}`;
  } else {
    key = `${ref.domainType.toLowerCase()} ${ref.domainName ?? `#${ref.domainId}`}`;
  }
  return `${key}${referenceConstraints(ref)}`;
}

// --- Reference graph ---

export interface TrackerEdge {
  fromId: number;
  fromName: string;
  field: string;
  multiple: boolean;
  reference: NormalizedReference;
}

/** Edges for references to tracker items; user, member and project references are not tracker links. */
export function buildReferenceEdges(trackers: NormalizedTracker[]): TrackerEdge[] {
  return trackers.flatMap((t) =>
    t.fields.flatMap((f) =>
      (f.references ?? []).filter((r) => r.kind === "items" && r.domainId !== undefined).map((reference) => ({
        fromId: t.id,
        fromName: t.name,
        field: f.name,
        multiple: f.multiple,
        reference,
      })),
    ),
  );
}

export type ProjectTrackers = Map<number, Array<{ id: number; name: string; type?: { id: number } }>>;

/** Projects whose trackers are needed to resolve "trackers of type X in project P" references. */
export function typeReferenceProjects(edges: TrackerEdge[]): number[] {
  const ids = edges
    .map((e) => e.reference)
    .filter((r) => r.domainType === "PROJECT" && r.targetIds.length > 0 && r.domainId !== undefined)
    .map((r) => r.domainId!);
  return [...new Set(ids)];
}

/**
 * Resolve "trackers of type X in project P" references to P's trackers of those types, so the graph
 * points at real trackers. References whose project is unknown or matches no tracker are kept as they are.
 */
export function expandTypeReferences(edges: TrackerEdge[], projectTrackers: ProjectTrackers): TrackerEdge[] {
  return edges.flatMap((edge) => {
    const ref = edge.reference;
    if (ref.domainType !== "PROJECT" || ref.domainId === undefined || ref.targetIds.length === 0) return [edge];
    const matches = (projectTrackers.get(ref.domainId) ?? []).filter(
      (t) => t.type !== undefined && ref.targetIds.includes(t.type.id),
    );
    if (matches.length === 0) return [edge];
    return matches.map((t) => ({
      ...edge,
      reference: {
        ...ref,
        domainType: "TRACKER",
        domainId: t.id,
        domainName: t.name,
        targetProjectName: ref.domainName,
        targetIds: [],
        targetTypeNames: [],
      },
    }));
  });
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
  ["dependency values", (f) => show(f.dependencyValues)],
  ["choice kind", (f) => show(f.choiceKind)],
  ["references", (f) => list((f.references ?? []).map(referenceKey))],
];

const OPTION_PROPERTIES: Array<[string, (o: NormalizedOption) => string]> = [
  ["restricted to statuses", (o) => list(o.restrictedToStatuses)],
  ["default in statuses", (o) => list(o.defaultInStatuses)],
  ["meanings", (o) => list(o.meanings)],
];

function compareFields(a: NormalizedField, b: NormalizedField): ValueChange[] {
  const changes: ValueChange[] = [];
  for (const [property, get] of FIELD_PROPERTIES) {
    const va = get(a);
    const vb = get(b);
    if (va !== vb) changes.push({ property, a: va, b: vb });
  }

  if (a.options || b.options) {
    const optsA = new Map((a.options ?? []).map((o) => [o.name.toLowerCase(), o]));
    const optsB = new Map((b.options ?? []).map((o) => [o.name.toLowerCase(), o]));
    // Added and removed statuses are reported in the statuses section; their metadata is compared here.
    if (!a.isStatus) {
      const onlyA = [...optsA.values()].filter((o) => !optsB.has(o.name.toLowerCase())).map((o) => o.name);
      const onlyB = [...optsB.values()].filter((o) => !optsA.has(o.name.toLowerCase())).map((o) => o.name);
      if (onlyA.length > 0 || onlyB.length > 0) {
        changes.push({ property: "options (only on this side)", a: list(onlyA), b: list(onlyB) });
      }
    }
    for (const [key, oa] of optsA) {
      const ob = optsB.get(key);
      if (!ob) continue;
      for (const [property, get] of OPTION_PROPERTIES) {
        if (get(oa) !== get(ob)) {
          changes.push({ property: `option "${oa.name}" ${property}`, a: get(oa), b: get(ob) });
        }
      }
    }
  }
  return changes;
}

function describeTransition(t: NormalizedTransition): string {
  return `${t.from} → ${t.to}${t.name ? ` ("${t.name}")` : ""}`;
}

function compareTransitions(
  a: NormalizedTransition[],
  b: NormalizedTransition[],
): Pick<TrackerDiff, "transitionsOnlyInA" | "transitionsOnlyInB" | "transitionChanges"> {
  const endpoints = (t: NormalizedTransition) => `${t.from} → ${t.to}`.toLowerCase();
  const groups = new Map<string, { a: NormalizedTransition[]; b: NormalizedTransition[] }>();
  for (const t of a) {
    const g = groups.get(endpoints(t)) ?? { a: [], b: [] };
    g.a.push(t);
    groups.set(endpoints(t), g);
  }
  for (const t of b) {
    const g = groups.get(endpoints(t)) ?? { a: [], b: [] };
    g.b.push(t);
    groups.set(endpoints(t), g);
  }

  const result: Pick<TrackerDiff, "transitionsOnlyInA" | "transitionsOnlyInB" | "transitionChanges"> = {
    transitionsOnlyInA: [],
    transitionsOnlyInB: [],
    transitionChanges: [],
  };
  for (const group of groups.values()) {
    // Pair transitions between the same statuses by name first; a single leftover on each side is a rename.
    const pairs: Array<[NormalizedTransition, NormalizedTransition]> = [];
    const restB = [...group.b];
    const restA: NormalizedTransition[] = [];
    for (const ta of group.a) {
      const index = restB.findIndex((tb) => tb.name.toLowerCase() === ta.name.toLowerCase());
      if (index >= 0) pairs.push([ta, restB.splice(index, 1)[0]]);
      else restA.push(ta);
    }
    if (restA.length === 1 && restB.length === 1) {
      pairs.push([restA[0], restB[0]]);
      restA.length = 0;
      restB.length = 0;
    }
    result.transitionsOnlyInA.push(...restA.map(describeTransition));
    result.transitionsOnlyInB.push(...restB.map(describeTransition));

    for (const [ta, tb] of pairs) {
      const changes: ValueChange[] = [];
      if (ta.name !== tb.name) changes.push({ property: "name", a: show(ta.name), b: show(tb.name) });
      if (ta.hidden !== tb.hidden) changes.push({ property: "hidden", a: show(ta.hidden), b: show(tb.hidden) });
      if (list(ta.allowed) !== list(tb.allowed)) {
        changes.push({ property: "allowed for", a: list(ta.allowed), b: list(tb.allowed) });
      }
      if (changes.length > 0) result.transitionChanges.push({ transition: describeTransition(ta), changes });
    }
  }
  return result;
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

  // A workflow that could not be loaded is unknown, not empty: compare only when both are available.
  const transitionsCompared = a.transitions !== undefined && b.transitions !== undefined;
  const transitions = transitionsCompared
    ? compareTransitions(a.transitions!, b.transitions!)
    : { transitionsOnlyInA: [], transitionsOnlyInB: [], transitionChanges: [] };

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
    ...transitions,
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
