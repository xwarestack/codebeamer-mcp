import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodebeamerClient } from "../client/codebeamer-client.js";
import {
  formatProjectList,
  formatProject,
} from "../formatters/project-formatter.js";
import { READ_ONLY } from "./annotations.js";

export function registerProjectTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List all Codebeamer projects the authenticated user can access. " +
        "Returns a summary table with project IDs, names, and keys. " +
        "Use the returned IDs to fetch trackers or items.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const result = await client.listProjects();
      return { content: [{ type: "text", text: formatProjectList(result) }] };
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description:
        "Get full details for a single Codebeamer project by its numeric ID.",
      inputSchema: {
        projectId: z
          .number()
          .int()
          .positive()
          .describe("Numeric Codebeamer project ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const project = await client.getProject(projectId);
      return { content: [{ type: "text", text: formatProject(project) }] };
    },
  );
}
