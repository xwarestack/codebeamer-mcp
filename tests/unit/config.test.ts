import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hasAccess, loadConfig } from "../../src/config.js";

const saved = { ...process.env };

beforeEach(() => {
  process.env.CB_URL = "https://cb.example.com/cb/api/";
  process.env.CB_USERNAME = "user";
  process.env.CB_PASSWORD = "secret";
  delete process.env.CB_MODE;
  delete process.env.CB_TIMEOUT_MS;
  delete process.env.CB_OPENAPI_SPEC;
});

afterEach(() => {
  process.env = { ...saved };
});

describe("loadConfig", () => {
  it("defaults to read-only mode and a 30 s timeout", () => {
    const config = loadConfig();
    expect(config.baseUrl).toBe("https://cb.example.com/cb/api/v3");
    expect(config.mode).toBe("read");
    expect(config.timeoutMs).toBe(30000);
    expect(config.openApiSpec).toBeUndefined();
  });

  it("reads CB_MODE case-insensitively and rejects unknown modes", () => {
    process.env.CB_MODE = "Admin";
    expect(loadConfig().mode).toBe("admin");

    process.env.CB_MODE = "root";
    expect(() => loadConfig()).toThrow(/Invalid CB_MODE "root"/);
  });

  it("validates CB_TIMEOUT_MS", () => {
    process.env.CB_TIMEOUT_MS = "120000";
    expect(loadConfig().timeoutMs).toBe(120000);

    process.env.CB_TIMEOUT_MS = "soon";
    expect(() => loadConfig()).toThrow(/Invalid CB_TIMEOUT_MS/);
  });
});

describe("hasAccess", () => {
  it("orders modes read < write < admin", () => {
    expect(hasAccess("read", "write")).toBe(false);
    expect(hasAccess("write", "write")).toBe(true);
    expect(hasAccess("admin", "write")).toBe(true);
    expect(hasAccess("write", "admin")).toBe(false);
  });
});
