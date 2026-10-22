import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// MCP tool hints that let clients auto-approve reads and ask before writes.

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/** Creates new data without changing or removing existing data. */
export const ADDITIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

/** May overwrite or remove existing data. */
export const DESTRUCTIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};
