import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodebeamerClient } from "../client/codebeamer-client.js";
import { formatUser, formatUserSearch } from "../formatters/user-formatter.js";
import { READ_ONLY } from "./annotations.js";

export function registerUserTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "get_user",
    {
      title: "Get User",
      description:
        "Get profile details for a Codebeamer user by their numeric ID. " +
        "User IDs appear in item fields like assignedTo and createdBy.",
      inputSchema: {
        userId: z.number().int().positive().describe("Numeric user ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ userId }) => {
      const user = await client.getUser(userId);
      return { content: [{ type: "text", text: formatUser(user) }] };
    },
  );

  server.registerTool(
    "find_user",
    {
      title: "Find User",
      description:
        "Find Codebeamer users by username, name fragment, or email address, to get the numeric user IDs " +
        "needed by assignment and permission tools. An email address triggers an exact email lookup.",
      inputSchema: {
        query: z.string().min(1).describe("Username, part of a name, or an email address"),
        page: z.number().int().min(1).default(1).describe("Page number (starts at 1)"),
        pageSize: z.number().int().min(1).max(100).default(25).describe("Users per page (max 100)"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, page, pageSize }) => {
      if (query.includes("@")) {
        const user = await client.findUserByEmail(query);
        return { content: [{ type: "text", text: formatUser(user) }] };
      }
      const result = await client.searchUsers(query, page, pageSize);
      return { content: [{ type: "text", text: formatUserSearch(query, result, page, pageSize) }] };
    },
  );
}
