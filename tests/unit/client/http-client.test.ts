import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mockServer } from "../../setup.js";
import { HttpClient } from "../../../src/client/http-client.js";
import {
  CbAuthError,
  CbNotFoundError,
  CbForbiddenError,
  CbRateLimitError,
  CbValidationError,
  CbError,
} from "../../../src/client/errors.js";

const BASE = "https://test-cb.example.com/v3";

function makeClient() {
  return new HttpClient({
    baseUrl: BASE,
    username: "testuser",
    password: "testpass",
  });
}

describe("HttpClient", () => {
  it("sends Basic Auth header", async () => {
    let receivedAuth = "";
    mockServer.use(
      http.get(`${BASE}/test-auth`, ({ request }) => {
        receivedAuth = request.headers.get("Authorization") ?? "";
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = makeClient();
    await client.get("/test-auth");

    const expected = `Basic ${Buffer.from("testuser:testpass").toString("base64")}`;
    expect(receivedAuth).toBe(expected);
  });

  it("appends query params", async () => {
    let receivedUrl = "";
    mockServer.use(
      http.get(`${BASE}/test-params`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = makeClient();
    await client.get("/test-params", { params: { page: 2, pageSize: 10 } });

    const url = new URL(receivedUrl);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("10");
  });

  it("skips undefined params", async () => {
    let receivedUrl = "";
    mockServer.use(
      http.get(`${BASE}/test-undef`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = makeClient();
    await client.get("/test-undef", { params: { a: "1", b: undefined } });

    const url = new URL(receivedUrl);
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("b")).toBe(false);
  });

  it("maps 401 to CbAuthError", async () => {
    mockServer.use(
      http.get(`${BASE}/fail`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const client = makeClient();
    await expect(client.get("/fail")).rejects.toThrow(CbAuthError);
  });

  it("maps 404 to CbNotFoundError", async () => {
    mockServer.use(
      http.get(`${BASE}/missing`, () =>
        HttpResponse.json({ message: "Not found" }, { status: 404 }),
      ),
    );

    const client = makeClient();
    await expect(
      client.get("/missing", { resource: "item 999" }),
    ).rejects.toThrow(CbNotFoundError);
  });

  it("maps 403 to CbForbiddenError", async () => {
    mockServer.use(
      http.get(`${BASE}/secret`, () =>
        HttpResponse.json({}, { status: 403 }),
      ),
    );

    const client = makeClient();
    await expect(client.get("/secret")).rejects.toThrow(CbForbiddenError);
  });

  it("maps 429 to CbRateLimitError after retrying", async () => {
    let calls = 0;
    mockServer.use(
      http.get(`${BASE}/limited`, () => {
        calls++;
        return HttpResponse.json({}, { status: 429 });
      }),
    );

    const client = new HttpClient({ baseUrl: BASE, username: "u", password: "p", retryDelayMs: 0 });
    await expect(client.get("/limited")).rejects.toThrow(CbRateLimitError);
    expect(calls).toBe(3);
  });

  it("retries a 429 and returns the later successful response", async () => {
    let calls = 0;
    mockServer.use(
      http.get(`${BASE}/flaky`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.json({}, { status: 429, headers: { "Retry-After": "0" } })
          : HttpResponse.json({ ok: true });
      }),
    );

    const client = makeClient();
    await expect(client.get("/flaky")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("fails with a clear message when the server does not answer in time", async () => {
    mockServer.use(
      http.get(`${BASE}/slow`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = new HttpClient({ baseUrl: BASE, username: "u", password: "p", timeoutMs: 20 });
    await expect(client.get("/slow")).rejects.toThrow(/did not respond within 20 ms/);
  });

  it("repeats array query params", async () => {
    let receivedUrl = "";
    mockServer.use(
      http.get(`${BASE}/multi`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    await makeClient().get("/multi", { params: { ids: [1, 2] } });
    expect(new URL(receivedUrl).searchParams.getAll("ids")).toEqual(["1", "2"]);
  });

  it("send() decodes non-JSON responses by content type", async () => {
    mockServer.use(
      http.get(`${BASE}/text`, () => HttpResponse.text("hello")),
      http.get(`${BASE}/binary`, () =>
        new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/octet-stream" } }),
      ),
    );

    const client = makeClient();
    expect((await client.send("GET", "/text")).body).toBe("hello");
    expect((await client.send("GET", "/binary")).body).toEqual({
      binary: true,
      contentType: "application/octet-stream",
      bytes: 3,
    });
  });

  it("maps 400 to CbValidationError", async () => {
    mockServer.use(
      http.get(`${BASE}/bad`, () =>
        HttpResponse.json({ message: "Invalid query" }, { status: 400 }),
      ),
    );

    const client = makeClient();
    await expect(client.get("/bad")).rejects.toThrow(CbValidationError);
  });

  it("maps unknown status to CbError", async () => {
    mockServer.use(
      http.get(`${BASE}/boom`, () =>
        HttpResponse.json({}, { status: 502 }),
      ),
    );

    const client = makeClient();
    await expect(client.get("/boom")).rejects.toThrow(CbError);
  });
});
