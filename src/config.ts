function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in the "env" section of your MCP client's server configuration, ` +
        `or as a system/user environment variable (see README > Installation).`,
    );
  }
  return value;
}

/**
 * Access level granted to the MCP client:
 * - read:  read-only tools; `api_call` limited to non-mutating operations
 * - write: also item/comment/association/attachment/wiki/test-run changes
 * - admin: also configuration, permission and deployment changes via `api_call`
 */
export type AccessMode = "read" | "write" | "admin";

const ACCESS_MODES: AccessMode[] = ["read", "write", "admin"];

export function hasAccess(mode: AccessMode, required: AccessMode): boolean {
  return ACCESS_MODES.indexOf(mode) >= ACCESS_MODES.indexOf(required);
}

export interface Config {
  baseUrl: string;
  username: string;
  password: string;
  unsafeSsl: boolean;
  mode: AccessMode;
  timeoutMs: number;
  /** File path or URL of the OpenAPI spec used by the api_* tools. Undefined = bundled spec. */
  openApiSpec?: string;
}

function parseMode(value: string | undefined): AccessMode {
  if (value === undefined || value === "") return "read";
  const mode = value.toLowerCase() as AccessMode;
  if (!ACCESS_MODES.includes(mode)) {
    throw new Error(
      `Invalid CB_MODE "${value}". Allowed values: ${ACCESS_MODES.join(", ")}.`,
    );
  }
  return mode;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === "") return 30000;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`Invalid CB_TIMEOUT_MS "${value}". Expected a positive integer.`);
  }
  return ms;
}

export function loadConfig(): Config {
  const host = requireEnv("CB_URL");
  const username = requireEnv("CB_USERNAME");
  const password = requireEnv("CB_PASSWORD");

  const unsafeSsl = process.env.CB_UNSAFE_SSL === "true";
  const mode = parseMode(process.env.CB_MODE);
  const timeoutMs = parseTimeout(process.env.CB_TIMEOUT_MS);
  const openApiSpec = process.env.CB_OPENAPI_SPEC || undefined;

  const baseUrl = `${host.replace(/\/$/, "")}/v3`;

  return { baseUrl, username, password, unsafeSsl, mode, timeoutMs, openApiSpec };
}
