import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodebeamerClient } from "../client/codebeamer-client.js";
import {
  buildReferenceEdges,
  expandTypeReferences,
  typeReferenceProjects,
  type ProjectTrackers,
  loadTrackerSnapshot,
  normalizeTracker,
  resolveLookups,
  type TrackerSnapshot,
} from "../analysis/tracker-config.js";
import { mapLimit } from "../analysis/concurrency.js";
import {
  formatReferenceTable,
  formatTrackerConfiguration,
  formatTrackerGraph,
  formatTrackerPermissions,
  formatWorkflow,
} from "../formatters/config-formatter.js";
import { READ_ONLY } from "./annotations.js";

const trackerIdSchema = z.number().int().positive().describe("Numeric tracker ID");

export function registerConfigurationTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "get_tracker_configuration",
    {
      title: "Get Tracker Configuration",
      description:
        "Get the full configuration of a tracker for review: settings, template relationship, every field " +
        "(type, mandatory/hidden rules, formulas, permissions, dependencies), statuses, choice options (enums) " +
        "and reference fields pointing to other trackers. Usually requires a project admin account. " +
        "Use format=json for machine-readable output.",
      inputSchema: {
        trackerId: trackerIdSchema,
        includeOptions: z.boolean().default(true).describe("List the options of every choice field"),
        format: z.enum(["markdown", "json"]).default("markdown").describe("Output format"),
      },
      annotations: READ_ONLY,
    },
    async ({ trackerId, includeOptions, format }) => {
      const snapshot = await loadTrackerSnapshot(client, trackerId, { transitions: false });
      const names = await resolveLookups(client, [snapshot]);
      const tracker = normalizeTracker(snapshot, names);
      const text =
        format === "json" ? JSON.stringify(tracker) : formatTrackerConfiguration(tracker, { includeOptions });
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get_tracker_workflow",
    {
      title: "Get Tracker Workflow",
      description:
        "Get the workflow of a tracker: statuses and every transition (from/to status, name, hidden flag, " +
        "which roles or user fields may execute it), with a Mermaid state diagram. " +
        "Transition guards and actions are not exposed by the Codebeamer REST API.",
      inputSchema: { trackerId: trackerIdSchema },
      annotations: READ_ONLY,
    },
    async ({ trackerId }) => {
      const snapshot = await loadTrackerSnapshot(client, trackerId, { transitions: true });
      const lookups = await resolveLookups(client, [snapshot]);
      return { content: [{ type: "text", text: formatWorkflow(normalizeTracker(snapshot, lookups)) }] };
    },
  );

  server.registerTool(
    "get_tracker_permissions",
    {
      title: "Get Tracker Permissions",
      description:
        "List the tracker-level permissions granted to each role on a tracker, optionally filtered to one role or " +
        "to the roles of one user. Field-level permissions are shown by get_tracker_configuration.",
      inputSchema: {
        trackerId: trackerIdSchema,
        roleId: z.number().int().positive().optional().describe("Only this role (see list_roles)"),
        userId: z.number().int().positive().optional().describe("Only the roles of this user (see find_user)"),
      },
      annotations: READ_ONLY,
    },
    async ({ trackerId, roleId, userId }) => {
      const permissions = await client.getTrackerPermissions(trackerId, { roleId, userId });
      return { content: [{ type: "text", text: formatTrackerPermissions(trackerId, permissions) }] };
    },
  );

  server.registerTool(
    "list_tracker_types",
    {
      title: "List Tracker Types",
      description: "List the tracker types defined in Codebeamer (Requirement, Bug, Test Case, ...) with their IDs.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const types = await client.listTrackerTypes();
      return { content: [{ type: "text", text: formatReferenceTable("Tracker types", types) }] };
    },
  );

  server.registerTool(
    "list_roles",
    {
      title: "List Roles",
      description: "List the roles defined in Codebeamer with their IDs, for permission review.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const roles = await client.listRoles();
      return { content: [{ type: "text", text: formatReferenceTable("Roles", roles) }] };
    },
  );

  server.registerTool(
    "list_association_types",
    {
      title: "List Association Types",
      description:
        "List the association types (depends on, related to, ...) with their IDs, as needed by create_association.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const types = await client.listAssociationTypes();
      return { content: [{ type: "text", text: formatReferenceTable("Association types", types) }] };
    },
  );

  server.registerTool(
    "get_project_members",
    {
      title: "Get Project Members",
      description: "List the members (users and groups) of a project.",
      inputSchema: {
        projectId: z.number().int().positive().describe("Numeric project ID"),
        page: z.number().int().min(1).default(1).describe("Page number (starts at 1)"),
        pageSize: z.number().int().min(1).max(500).default(100).describe("Members per page (max 500)"),
      },
      annotations: READ_ONLY,
    },
    async ({ projectId, page, pageSize }) => {
      const result = await client.getProjectMembers(projectId, page, pageSize);
      const total = result.total ?? result.items.length;
      const footer = page * pageSize < total ? `_${total} members in total: request page ${page + 1} for more._` : undefined;
      return {
        content: [
          { type: "text", text: formatReferenceTable(`Members of project ${projectId}`, result.items, footer) },
        ],
      };
    },
  );

  server.registerTool(
    "get_project_tracker_graph",
    {
      title: "Get Project Tracker Reference Graph",
      description:
        "Map which trackers of a project reference which other trackers or projects through reference fields " +
        "(e.g. Test Case → Requirement), as a table and Mermaid diagram. Loads every tracker's configuration, " +
        "so it can take a while on large projects.",
      inputSchema: {
        projectId: z.number().int().positive().describe("Numeric project ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const trackers = await client.listTrackers(projectId);
      const warnings: string[] = [];
      const snapshots = (
        await mapLimit(trackers, 4, async (t) => {
          try {
            return await loadTrackerSnapshot(client, t.id, { transitions: false });
          } catch (err) {
            warnings.push(`${t.name} [${t.id}]: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          }
        })
      ).filter((s): s is TrackerSnapshot => s !== undefined);

      const lookups = await resolveLookups(client, snapshots);
      const normalized = snapshots.map((s) => normalizeTracker(s, lookups));
      warnings.push(...normalized.flatMap((t) => t.warnings));

      // Type references ("trackers of type X in project P") are resolved against P's trackers.
      const edges = buildReferenceEdges(normalized);
      const projectTrackers: ProjectTrackers = new Map([[projectId, trackers]]);
      await mapLimit(
        typeReferenceProjects(edges).filter((id) => !projectTrackers.has(id)),
        3,
        async (id) => {
          try {
            projectTrackers.set(id, await client.listTrackers(id));
          } catch (err) {
            warnings.push(`Trackers of project ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      );

      const text = formatTrackerGraph(
        `Tracker reference graph of project ${projectId}`,
        normalized,
        expandTypeReferences(edges, projectTrackers),
        warnings,
      );
      return { content: [{ type: "text", text }] };
    },
  );
}
