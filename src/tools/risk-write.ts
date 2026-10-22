import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CodebeamerClient,
  CbTrackerSchemaField,
} from "../client/codebeamer-client.js";
import { formatItem } from "../formatters/item-formatter.js";
import { ADDITIVE_WRITE } from "./annotations.js";

function findField(
  schema: CbTrackerSchemaField[],
  trackerId: number,
  label: string,
  pattern: RegExp,
): CbTrackerSchemaField {
  const field = schema.find((f) => pattern.test(f.name));
  if (!field) {
    throw new Error(
      `Tracker ${trackerId} has no ${label} field (looked for a field name matching ${pattern}). ` +
        `Available fields: ${schema.map((f) => f.name).join(", ")}.`,
    );
  }
  return field;
}

export function registerRiskWriteTools(
  server: McpServer,
  client: CodebeamerClient,
): void {
  server.registerTool(
    "create_harm",
    {
      title: "Create Harm",
      description:
        "Create a new item in a Codebeamer RM Harms List tracker. " +
        "Supports setting the IMDRF code (text) and Severity (integer 1–5). " +
        "Use list_trackers to find the Harms List tracker ID for your project.",
      inputSchema: {
        trackerId: z
          .number()
          .int()
          .positive()
          .describe("Numeric tracker ID of the RM Harms List tracker"),
        name: z.string().min(1).describe("Harm name / summary"),
        description: z
          .string()
          .optional()
          .describe("Harm description (plain text or wiki markup)"),
        imdrfCode: z
          .string()
          .optional()
          .describe("IMDRF code for this harm (e.g. 'E0001')"),
        severity: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Severity level (integer 1–5)"),
        parentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Parent item ID to nest this harm inside (e.g. a folder)"),
      },
      annotations: ADDITIVE_WRITE,
    },
    async ({ trackerId, name, description, imdrfCode, severity, parentId }) => {
      const customFields: Array<{ fieldId: number; type: string; value: unknown }> = [];

      if (imdrfCode !== undefined || severity !== undefined) {
        // Custom field IDs differ between trackers, so resolve them by name instead of hardcoding.
        const schema = await client.getTrackerSchema(trackerId);
        if (imdrfCode !== undefined) {
          const field = findField(schema, trackerId, "IMDRF code", /imdrf/i);
          customFields.push({ fieldId: field.id, type: "TextFieldValue", value: imdrfCode });
        }
        if (severity !== undefined) {
          const field = findField(schema, trackerId, "Severity", /severity/i);
          customFields.push({ fieldId: field.id, type: "IntegerFieldValue", value: severity });
        }
      }

      const data = {
        name,
        ...(description !== undefined ? { description } : {}),
        ...(customFields.length > 0 ? { customFields } : {}),
      };

      const item = await client.createItem(trackerId, data, parentId);
      return { content: [{ type: "text", text: formatItem(item) }] };
    },
  );
}
