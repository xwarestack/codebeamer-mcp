import type { Config } from "../config.js";
import { mapHttpError } from "./errors.js";

export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | Array<string | number | boolean>;

export interface RequestOptions {
  params?: Record<string, QueryValue>;
  resource?: string;
}

export interface BodyRequestOptions extends RequestOptions {
  body?: unknown;
  formData?: Record<string, string>;
}

export type HttpClientConfig = Pick<Config, "baseUrl" | "username" | "password"> & {
  timeoutMs?: number;
  userAgent?: string;
  /** Base delay before retrying a 429 response without a Retry-After header. */
  retryDelayMs?: number;
};

/** Response of {@link HttpClient.send}: body decoded according to its content type. */
export interface RawResponse {
  status: number;
  contentType: string;
  body: unknown;
}

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10000;

export class HttpClient {
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly retryDelayMs: number;

  constructor(private readonly config: HttpClientConfig) {
    const encoded = Buffer.from(
      `${config.username}:${config.password}`,
    ).toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.userAgent = config.userAgent ?? "codebeamer-mcp";
    this.retryDelayMs = config.retryDelayMs ?? 1000;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async post<T>(path: string, options: BodyRequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, options);
  }

  async put<T>(path: string, options: BodyRequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, options);
  }

  async delete<T>(path: string, options: BodyRequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /**
   * Generic request used by `api_call`: accepts any method and decodes the body by
   * content type (JSON, text, or a size summary for binary content).
   */
  async send(
    method: string,
    path: string,
    options: BodyRequestOptions = {},
  ): Promise<RawResponse> {
    const response = await this.fetchChecked(method, path, options);
    const contentType = response.headers.get("content-type") ?? "";

    if (response.status === 204) {
      return { status: response.status, contentType, body: undefined };
    }
    if (contentType === "" || /json/i.test(contentType)) {
      const text = await response.text();
      if (text === "") return { status: response.status, contentType, body: undefined };
      try {
        return { status: response.status, contentType, body: JSON.parse(text) };
      } catch {
        return { status: response.status, contentType, body: text };
      }
    }
    if (/^text\/|xml|html/i.test(contentType)) {
      return { status: response.status, contentType, body: await response.text() };
    }
    const buffer = await response.arrayBuffer();
    return {
      status: response.status,
      contentType,
      body: { binary: true, contentType, bytes: buffer.byteLength },
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: BodyRequestOptions = {},
  ): Promise<T> {
    const response = await this.fetchChecked(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  private buildUrl(path: string, params?: Record<string, QueryValue>): string {
    const url = new URL(`${this.config.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async fetchChecked(
    method: string,
    path: string,
    options: BodyRequestOptions,
  ): Promise<Response> {
    const url = this.buildUrl(path, options.params);

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };

    const init: RequestInit = { method, headers };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    } else if (options.formData !== undefined) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(options.formData)) {
        fd.append(key, value);
      }
      init.body = fd;
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new Error(
            `Codebeamer did not respond within ${this.timeoutMs} ms (${method} ${path}). ` +
              `Increase CB_TIMEOUT_MS for slow endpoints.`,
          );
        }
        const cause = err instanceof Error ? err.message : String(err);
        const nested =
          err instanceof Error &&
          err.cause instanceof Error
            ? ` (${err.cause.message})`
            : "";
        throw new Error(
          `Cannot connect to Codebeamer at ${this.config.baseUrl}. ` +
            `Check that CB_URL is correct and the server is reachable. Cause: ${cause}${nested}`,
        );
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Drain the body so the connection can be reused.
        await response.arrayBuffer().catch(() => undefined);
        await sleep(this.retryDelay(response, attempt));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        throw mapHttpError(response.status, body, options.resource ?? path);
      }

      return response;
    }
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.has("retry-after")) {
      return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    }
    return this.retryDelayMs * 2 ** attempt;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
