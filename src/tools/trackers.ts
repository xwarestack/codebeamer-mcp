import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodebeamerClient } from "../client/codebeamer-client.js";
import {
  formatTrackerList,
  formatTracker,
} from "../formatters/tracker-formatter.js";
import { READ_ONLY } from "./annotations.js";

export function registerTrackerTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "list_trackers",
    {
      title: "List Trackers",
      description:
        "List all trackers (Requirements, Bugs, Test Cases, etc.) in a Codebeamer project. " +
        "Use the returned tracker IDs to list items or get tracker details.",
      inputSchema: {
        projectId: z
          .number()
          .int()
          .positive()
          .describe("Numeric project ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ projectId }) => {
      const result = await client.listTrackers(projectId);
      return { content: [{ type: "text", text: formatTrackerList(result) }] };
    },
  );

  server.registerTool(
    "get_tracker",
    {
      title: "Get Tracker",
      description:
        "Get details of a Codebeamer tracker including its field schema. " +
        "The field list shows what fields are available for items in this tracker, " +
        "useful for constructing cbQL queries.",
      inputSchema: {
        trackerId: z
          .number()
          .int()
          .positive()
          .describe("Numeric tracker ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ trackerId }) => {
      const [tracker, fields, { items }] = await Promise.all([
        client.getTracker(trackerId),
        client.getTrackerFields(trackerId),
        client.listTrackerItems(trackerId, 1, 100),
      ]);
      return {
        content: [{ type: "text", text: formatTracker(tracker, fields, items) }],
      };
    },
  );
}
