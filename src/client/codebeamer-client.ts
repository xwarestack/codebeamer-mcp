import { HttpClient } from "./http-client.js";
import { CbAuthError, CbError } from "./errors.js";

// --- Response types (only fields used by formatters) ---

export interface CbReference {
  id: number;
  name: string;
  type?: string;
}

export interface CbProject {
  id: number;
  name: string;
  keyName?: string;
  description?: string;
  category?: string;
  closed?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CbTracker {
  id: number;
  name: string;
  type?: CbReference;
  project?: CbReference;
  description?: string;
  keyName?: string;
  templateTracker?: CbReference;
  hidden?: boolean;
}

export interface CbTrackerField {
  fieldId: number;
  name: string;
  type?: string;
  required?: boolean;
  hidden?: boolean;
}

export interface CbTrackerSchemaOption {
  id: number;
  name: string;
}

export interface CbTrackerSchemaField {
  id: number;
  name: string;
  type?: string;
  trackerItemField?: string;
  legacyRestName?: string;
  options?: CbTrackerSchemaOption[];
  hidden?: boolean;
  multipleValues?: boolean;
  referenceType?: string;
}

export interface CbTestStep {
  index?: number;
  actionDescription?: string;
  expectedResults?: string;
}

export interface CbItem {
  id: number;
  name: string;
  typeName?: string;
  description?: string | { markup?: string; value?: string };
  tracker?: CbReference;
  project?: CbReference;
  status?: CbReference;
  priority?: CbReference;
  assignedTo?: CbReference[];
  categories?: CbReference[];
  createdAt?: string;
  updatedAt?: string;
  submittedAt?: string;
  createdBy?: CbReference;
  modifiedBy?: CbReference;
  storyPoints?: number;
  customFields?: Array<{ fieldId: number; name: string; type?: string; value?: unknown; values?: unknown[] }>;
}

export interface CbRelation {
  id: number;
  type?: CbReference;
  itemRevision?: { id: number; name: string; version?: number };
}

export interface CbItemRelationsPage {
  outgoingAssociations?: CbRelation[];
  incomingAssociations?: CbRelation[];
  upstreamReferences?: CbRelation[];
  downstreamReferences?: CbRelation[];
}

export interface CbComment {
  id: number;
  comment?: string;
  commentFormat?: string;
  createdAt?: string;
  createdBy?: CbReference;
}

export interface CbUser {
  id: number;
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  status?: string;
  registryDate?: string;
}

export interface CbTrackerItemReviewConfig {
  requiredApprovals?: number;
  requiredRejections?: number;
  requiredSignature?: "NONE" | "PASSWORD" | "USERNAME_AND_PASSWORD";
  roleRequired?: boolean;
}

export interface CbTrackerItemReviewVote {
  user?: CbReference;
  asRole?: CbReference;
  decision?: "APPROVED" | "REJECTED" | "UNDECIDED";
  reviewedAt?: string;
}

export interface CbTrackerItemReview {
  config?: CbTrackerItemReviewConfig;
  result?: "APPROVED" | "REJECTED" | "UNDECIDED";
  reviewers?: CbTrackerItemReviewVote[];
  trackerItem?: { id: number; name: string; version?: number };
}

// --- Request types for write operations ---

export interface CbCreateItemRequest {
  name: string;
  description?: string;
  categories?: Array<{ id: number; type: string }>;
  status?: { id: number };
  priority?: { id: number };
  assignedTo?: Array<{ id: number }>;
  storyPoints?: number;
  customFields?: Array<{ fieldId: number; type: string; value: unknown }>;
}

export interface CbUpdateItemRequest {
  name?: string;
  description?: string;
  status?: { id: number; type?: string };
  priority?: { id: number };
  assignedTo?: Array<{ id: number }>;
  storyPoints?: number;
  customFields?: Array<{ fieldId: number; type: string; values?: Array<{ id: number; type: string }>; value?: unknown }>;
}

export interface CbEditableField {
  fieldId: number;
  name: string;
  values?: Array<{ id: number; name?: string; type?: string }>;
  value?: unknown;
  type?: string;
}

export interface CbCreateCommentRequest {
  comment: string;
  commentFormat?: string;
}

export interface CbCreateAssociationRequest {
  from: { id: number };
  to: { id: number };
  type: { id: number };
  description?: string;
}

export interface CbAssociation {
  id: number;
  from?: CbReference;
  to?: CbReference;
  type?: CbReference;
  description?: string;
}

export interface CbPage<T> {
  items: T[];
  total?: number;
  page?: number;
  pageSize?: number;
}

// --- Configuration types (GET /tracker/{id}/configuration and related) ---

export interface CbTrackerBasicInformation {
  trackerId?: number;
  projectId?: number;
  name?: string;
  key?: string;
  description?: string;
  issueTypeId?: number;
  template?: boolean;
  templateId?: number;
  workflowIsActive?: boolean;
  locked?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface CbChoiceOptionConfig {
  id: number;
  name: string;
  color?: string;
  description?: string;
  meanings?: string[];
  restrictedToStatuses?: number[];
  defaultInStatuses?: number[];
}

export interface CbReferenceFilter {
  id?: number;
  domainId?: number;
  domainType?: string;
  filterId?: number;
  filterStatusId?: number;
  targetIds?: number[];
  targetPermissions?: string[];
}

export interface CbFieldAccessGrant {
  access?: string;
  subjectId?: number;
  subjectType?: string;
}

// Discriminated by `type` (UNRESTRICTED, SINGLE, PER_STATUS, SAME_AS); each variant has one of these properties.
export interface CbFieldPermission {
  type?: string;
  accessPermissions?: CbFieldAccessGrant[];
  accessPermissionsPerStatusMap?: Record<string, CbFieldAccessGrant[]>;
  sameAsId?: number;
}

// Discriminated by `type` in the spec (CHOICE_OPTIONS, CHOICE_TRACKERS, CHOICE_USERS, ...);
// consumers check the shape instead, since the discriminator values vary between versions.
export interface CbChoiceOptionSetting {
  type?: string;
  choiceOptions?: CbChoiceOptionConfig[];
  referenceFilters?: CbReferenceFilter[];
}

export interface CbTrackerFieldConfig {
  referenceId?: number;
  label?: string;
  title?: string;
  typeId?: number;
  description?: string;
  mandatory?: boolean;
  hidden?: boolean;
  multipleSelection?: boolean;
  computedAs?: string;
  hideIfFormula?: string;
  mandatoryIfFormula?: string;
  mandatoryExceptInStatus?: number[];
  choiceOptionSetting?: CbChoiceOptionSetting;
  permission?: CbFieldPermission;
  dependency?: { dependentFieldId?: number; valueCombinations?: Record<string, string> };
  position?: number;
  [key: string]: unknown;
}

export interface CbTrackerConfiguration {
  basicInformation?: CbTrackerBasicInformation;
  fields?: CbTrackerFieldConfig[];
}

export interface CbAccessPermission {
  accessLevel?: string;
  role?: CbReference;
  project?: CbReference;
  field?: CbReference;
}

export interface CbWorkflowTransition {
  id: number;
  name?: string;
  description?: string;
  fromStatus?: CbReference;
  toStatus?: CbReference;
  hidden?: boolean;
  permissions?: CbAccessPermission[];
}

export interface CbRoleWithPermissions {
  role?: CbReference;
  trackerPermissions?: CbReference[];
}

export interface CbAssociationType {
  id: number;
  name: string;
  description?: string;
}

// --- Helpers ---

// Codebeamer API returns either a plain array or a paginated object depending on the endpoint/version.
// Known keys: "items" (query endpoint), "itemRefs" (tracker items endpoint in some versions),
// "members" / "users" / "trackers" (member, user and tracker search results).
const KNOWN_ARRAY_KEYS = ["items", "itemRefs", "members", "users", "trackers"];

function toArray<T>(response: unknown): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of KNOWN_ARRAY_KEYS) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
    // Generic fallback: find first array-valued key
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        console.error(`[codebeamer-mcp] Using response key "${key}" instead of "items"`);
        return obj[key] as T[];
      }
    }
    console.error("[codebeamer-mcp] No array found in response:", JSON.stringify(obj).slice(0, 300));
  }
  return [];
}

function toPage<T>(response: unknown): CbPage<T> {
  const items = toArray<T>(response);
  if (Array.isArray(response) || !response || typeof response !== "object") return { items };
  const obj = response as Record<string, unknown>;
  const num = (key: string) => (typeof obj[key] === "number" ? (obj[key] as number) : undefined);
  return { items, total: num("total"), page: num("page"), pageSize: num("pageSize") };
}

// --- Client ---

export class CodebeamerClient {
  constructor(private readonly http: HttpClient) {}

  // Projects (the v3 endpoint is not paginated: it always returns every accessible project)
  async listProjects(): Promise<CbProject[]> {
    const raw = await this.http.get<unknown>("/projects", {
      resource: "projects",
    });
    return toArray(raw);
  }

  getProject(id: number): Promise<CbProject> {
    return this.http.get(`/projects/${id}`, { resource: `project ${id}` });
  }

  // Trackers. The search endpoint returns full trackers (type, key, template) in one call; the plain
  // list only has IDs and names, so it remains the fallback for versions without search.
  async listTrackers(projectId: number): Promise<CbTracker[]> {
    try {
      const raw = await this.http.post<unknown>(`/projects/${projectId}/trackers/search`, {
        body: {},
        resource: `trackers for project ${projectId}`,
      });
      return toArray(raw);
    } catch (err) {
      if (!(err instanceof CbError) || err instanceof CbAuthError) throw err;
    }
    const raw = await this.http.get<unknown>(`/projects/${projectId}/trackers`, {
      resource: `trackers for project ${projectId}`,
    });
    return toArray(raw);
  }

  getTracker(id: number): Promise<CbTracker> {
    return this.http.get(`/trackers/${id}`, { resource: `tracker ${id}` });
  }

  getTrackerFields(id: number): Promise<CbTrackerField[]> {
    return this.http.get(`/trackers/${id}/fields`, {
      resource: `fields for tracker ${id}`,
    });
  }

  getTrackerSchema(id: number): Promise<CbTrackerSchemaField[]> {
    return this.http.get(`/trackers/${id}/schema`, {
      resource: `schema for tracker ${id}`,
    });
  }

  // Items
  getItem(id: number): Promise<CbItem> {
    return this.http.get(`/items/${id}`, { resource: `item ${id}` });
  }

  async listTrackerItems(
    trackerId: number,
    page: number,
    pageSize: number,
  ): Promise<CbPage<CbItem> & { debug?: string }> {
    const raw = await this.http.get<unknown>("/items/query", {
      params: { queryString: `tracker.id IN (${trackerId})`, page, pageSize },
      resource: `items for tracker ${trackerId}`,
    });
    const result = toPage<CbItem>(raw);
    if (result.items.length > 0) return result;

    // Items empty — also try the direct endpoint so we can show raw debug info
    let rawDirect: unknown;
    try {
      rawDirect = await this.http.get<unknown>(`/trackers/${trackerId}/items`, {
        params: { page, pageSize },
        resource: `items for tracker ${trackerId} (direct)`,
      });
    } catch {
      rawDirect = null;
    }
    const rawObj = raw as Record<string, unknown> | null;
    const directObj = rawDirect as Record<string, unknown> | null;
    const queryTotal = rawObj?.["total"] ?? "?";
    const directTotal = directObj?.["total"] ?? "?";
    const direct = toPage<CbItem>(rawDirect);
    const debug =
      `API returned total=${queryTotal} for the cbQL query and total=${directTotal} for the direct endpoint.\n` +
      `total=0 means Codebeamer reports no items (wrong tracker ID, missing permission, or an empty tracker).\n` +
      `query: ${JSON.stringify(raw).slice(0, 300)}\n` +
      `direct: ${JSON.stringify(rawDirect).slice(0, 300)}`;
    return { ...direct, debug };
  }

  async searchItems(
    queryString: string,
    page: number,
    pageSize: number,
  ): Promise<CbPage<CbItem>> {
    const raw = await this.http.get<unknown>("/items/query", {
      params: { queryString, page, pageSize },
      resource: "item query",
    });
    return toPage(raw);
  }

  // Item reviews (Review Hub)
  async getItemReviews(id: number): Promise<CbTrackerItemReview[]> {
    const raw = await this.http.get<unknown>(`/items/${id}/reviews`, {
      resource: `reviews for item ${id}`,
    });
    return Array.isArray(raw) ? raw : [];
  }

  // Item details
  getItemRelations(id: number): Promise<CbItemRelationsPage> {
    return this.http.get(`/items/${id}/relations`, {
      resource: `relations for item ${id}`,
    });
  }

  async getItemComments(id: number): Promise<CbComment[]> {
    const raw = await this.http.get<unknown>(`/items/${id}/comments`, {
      resource: `comments for item ${id}`,
    });
    return toArray(raw);
  }

  // Users
  getUser(id: number): Promise<CbUser> {
    return this.http.get(`/users/${id}`, { resource: `user ${id}` });
  }

  findUserByEmail(email: string): Promise<CbUser> {
    return this.http.get("/users/findByEmail", {
      params: { email },
      resource: `user with email ${email}`,
    });
  }

  async searchUsers(queryString: string, page: number, pageSize: number): Promise<CbPage<CbReference>> {
    const raw = await this.http.get<unknown>("/users", {
      params: { queryString, page, pageSize },
      resource: "user search",
    });
    return toPage(raw);
  }

  // Configuration
  getTrackerConfiguration(trackerId: number): Promise<CbTrackerConfiguration> {
    return this.http.get(`/tracker/${trackerId}/configuration`, {
      resource: `configuration of tracker ${trackerId}`,
    });
  }

  async getTrackerTransitions(trackerId: number): Promise<CbWorkflowTransition[]> {
    const raw = await this.http.get<unknown>(`/trackers/${trackerId}/transitions`, {
      resource: `transitions of tracker ${trackerId}`,
    });
    return toArray(raw);
  }

  async getTrackerPermissions(
    trackerId: number,
    filter: { roleId?: number; userId?: number } = {},
  ): Promise<CbRoleWithPermissions[]> {
    const raw = await this.http.get<unknown>(`/trackers/${trackerId}/permissions`, {
      params: { roleId: filter.roleId, userId: filter.userId },
      resource: `permissions of tracker ${trackerId}`,
    });
    return toArray(raw);
  }

  async listTrackerTypes(): Promise<CbReference[]> {
    const raw = await this.http.get<unknown>("/trackers/types", { resource: "tracker types" });
    return toArray(raw);
  }

  async listRoles(): Promise<CbReference[]> {
    const raw = await this.http.get<unknown>("/roles", { resource: "roles" });
    return toArray(raw);
  }

  async listAssociationTypes(): Promise<CbAssociationType[]> {
    const raw = await this.http.get<unknown>("/associations/types", { resource: "association types" });
    return toArray(raw);
  }

  async getProjectMembers(projectId: number, page: number, pageSize: number): Promise<CbPage<CbReference>> {
    const raw = await this.http.get<unknown>(`/projects/${projectId}/members`, {
      params: { page, pageSize },
      resource: `members of project ${projectId}`,
    });
    return toPage(raw);
  }

  // --- Write operations ---

  createItem(trackerId: number, data: CbCreateItemRequest, parentId?: number): Promise<CbItem> {
    return this.http.post(`/trackers/${trackerId}/items`, {
      params: parentId !== undefined ? { parentItemId: parentId } : undefined,
      body: data,
      resource: `create item in tracker ${trackerId}`,
    });
  }

  async updateItem(itemId: number, data: CbUpdateItemRequest): Promise<CbItem> {
    // Use the field-based endpoint so updates of individual fields (e.g. description)
    // do not trigger an unintended status transition on the full-item PUT endpoint.
    const item = await this.getItem(itemId);
    const trackerId = item.tracker?.id;
    if (!trackerId) throw new Error(`Cannot determine tracker for item ${itemId}`);

    const schema = await this.getTrackerSchema(trackerId);
    const fieldByLegacy = (legacyName: string) =>
      schema.find((f) => f.legacyRestName === legacyName);

    const fieldValues: Array<Record<string, unknown>> = [];
    const missing: string[] = [];
    const set = (
      requested: string,
      field: CbTrackerSchemaField | undefined,
      value: Record<string, unknown>,
    ) => {
      if (field) fieldValues.push({ fieldId: field.id, ...value });
      else missing.push(requested);
    };

    if (data.name !== undefined) {
      set("name", fieldByLegacy("name") ?? fieldByLegacy("summary"), { type: "TextFieldValue", value: data.name });
    }
    if (data.description !== undefined) {
      set("description", fieldByLegacy("description"), { type: "WikiTextFieldValue", value: data.description });
    }
    if (data.status !== undefined) {
      set("status", fieldByLegacy("status"), {
        type: "ChoiceFieldValue",
        values: [{ id: data.status.id, type: "ChoiceOptionReference" }],
      });
    }
    if (data.priority !== undefined) {
      set("priority", fieldByLegacy("priority"), {
        type: "ChoiceFieldValue",
        values: [{ id: data.priority.id, type: "ChoiceOptionReference" }],
      });
    }
    if (data.assignedTo !== undefined) {
      set("assignedTo", fieldByLegacy("assignedTo"), {
        type: "ChoiceFieldValue",
        values: data.assignedTo.map((u) => ({ id: u.id, type: "UserReference" })),
      });
    }
    if (data.storyPoints !== undefined) {
      set("storyPoints", fieldByLegacy("storyPoints"), { type: "IntegerFieldValue", value: data.storyPoints });
    }

    // Refuse partial updates: silently dropping a requested field would report success for a change that never happened.
    if (missing.length > 0) {
      throw new Error(
        `Tracker ${trackerId} has no field for: ${missing.join(", ")}. Nothing was updated.`,
      );
    }

    if (fieldValues.length === 0) return item;

    await this.http.put(`/items/${itemId}/fields`, {
      params: { quietMode: true },
      body: { fieldValues },
      resource: `update item ${itemId}`,
    });

    return this.getItem(itemId);
  }

  addComment(itemId: number, data: CbCreateCommentRequest): Promise<CbComment> {
    return this.http.post(`/items/${itemId}/comments`, {
      formData: {
        comment: data.comment,
        ...(data.commentFormat ? { commentFormat: data.commentFormat } : {}),
      },
      resource: `add comment to item ${itemId}`,
    });
  }

  createAssociation(data: CbCreateAssociationRequest): Promise<CbAssociation> {
    return this.http.post("/associations", {
      body: data,
      resource: "create association",
    });
  }

  async getItemEditableFields(id: number): Promise<CbEditableField[]> {
    const raw = await this.http.get<{ editableFields?: CbEditableField[] }>(
      `/items/${id}/fields`,
      { resource: `editable fields for item ${id}` },
    );
    return raw.editableFields ?? [];
  }

  async createDownstreamReference(fromItemId: number, toItemId: number): Promise<void> {
    // Downstream reference is created by setting the "superordinateRequirement" field
    // on the downstream (to) item to point to the upstream (from) item.
    const toItem = await this.getItem(toItemId);
    const trackerId = toItem.tracker?.id;
    if (!trackerId) throw new Error(`Cannot determine tracker for item ${toItemId}`);

    const schema = await this.getTrackerSchema(trackerId);
    const superordinateField = schema.find(
      (f) => f.legacyRestName === "superordinateRequirement",
    );
    if (!superordinateField) {
      throw new Error(
        `Tracker ${trackerId} has no superordinateRequirement field. Cannot create downstream reference.`,
      );
    }

    const fields = await this.getItemEditableFields(toItemId);
    const currentField = fields.find((f) => f.fieldId === superordinateField.id);
    const existingValues = currentField?.values ?? [];
    if (existingValues.some((v) => v.id === fromItemId)) return; // already linked

    const newValues = [...existingValues, { id: fromItemId, type: "TrackerItemReference" }];

    await this.http.put(`/items/${toItemId}/fields`, {
      params: { quietMode: true },
      body: {
        fieldValues: [
          {
            fieldId: superordinateField.id,
            type: "ChoiceFieldValue",
            values: newValues,
          },
        ],
      },
      resource: `add downstream reference from ${fromItemId} to ${toItemId}`,
    });
  }
}
