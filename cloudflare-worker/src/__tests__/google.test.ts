import { describe, it, expect, vi, afterEach } from "vitest";
import {
  googleFetch, gmailRequest, calendarRequest, driveRequest,
  docsRequest, sheetsRequest, slidesRequest, appsScriptRequest,
} from "../google";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string; jsonThrows?: boolean; textThrows?: boolean }) {
  const { ok = true, status = 200, json, text = "", jsonThrows = false, textThrows = false } = opts;
  return {
    ok,
    status,
    json: async () => { if (jsonThrows) throw new Error("not json"); return json; },
    text: async () => { if (textThrows) throw new Error("no body"); return text; },
  } as unknown as Response;
}

type FetchArgs = [url: string, init: RequestInit];

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as { mock: { calls: FetchArgs[] } };
}

describe("googleFetch", () => {
  it("sends a Bearer auth header and Accept: application/json on a GET with no body", async () => {
    const fetchMock = stubFetch(async () => mockResponse({ json: { ok: true } }));

    const result = await googleFetch("https://example.com/x", "token-1");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://example.com/x");
    expect(init.method).toBe("GET");
    expect(headers.Authorization).toBe("Bearer token-1");
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("serializes a body as JSON and sets Content-Type when a body is provided", async () => {
    const fetchMock = stubFetch(async () => mockResponse({ json: { id: "1" } }));

    await googleFetch("https://example.com/x", "token-1", "POST", { name: "hello" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "hello" }));
  });

  it("returns null for a 204 No Content response without parsing a body", async () => {
    const jsonSpy = vi.fn();
    stubFetch(async () => ({
      ok: true, status: 204, json: jsonSpy, text: async () => "",
    } as unknown as Response));

    const result = await googleFetch("https://example.com/x", "token-1", "DELETE");

    expect(result).toBeNull();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("throws a descriptive error including method, url, status, and body on failure", async () => {
    stubFetch(async () => mockResponse({
      ok: false, status: 403, text: '{"error":"insufficient scope"}',
    }));

    await expect(googleFetch("https://example.com/x", "token-1", "PATCH"))
      .rejects.toThrow('Google API error [PATCH https://example.com/x] → 403: {"error":"insufficient scope"}');
  });

  it("falls back to a generic HTTP status message when reading the error body itself fails", async () => {
    stubFetch(async () => mockResponse({ ok: false, status: 500, textThrows: true }));

    await expect(googleFetch("https://example.com/x", "token-1"))
      .rejects.toThrow("Google API error [GET https://example.com/x] → 500: HTTP 500");
  });
});

describe("per-service request helpers", () => {
  function captureUrl() {
    return stubFetch(async () => mockResponse({ json: {} }));
  }

  it("gmailRequest builds a users/me-scoped Gmail API URL", async () => {
    const fetchMock = captureUrl();
    await gmailRequest("t", "/messages/123");
    expect(fetchMock.mock.calls[0][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/123");
  });

  it("calendarRequest builds a Calendar API v3 URL", async () => {
    const fetchMock = captureUrl();
    await calendarRequest("t", "/calendars/primary/events");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  });

  it("driveRequest builds a Drive API v3 URL", async () => {
    const fetchMock = captureUrl();
    await driveRequest("t", "/files/abc");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.googleapis.com/drive/v3/files/abc");
  });

  it("docsRequest builds a documents/{id} URL with path appended after the id, and defaults path/method", async () => {
    const fetchMock = captureUrl();
    await docsRequest("t", "doc-1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://docs.googleapis.com/v1/documents/doc-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");

    await docsRequest("t", "doc-1", ":batchUpdate", "POST", { requests: [] });
    expect(fetchMock.mock.calls[1][0]).toBe("https://docs.googleapis.com/v1/documents/doc-1:batchUpdate");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("sheetsRequest builds a spreadsheets/{id} URL and supports batchUpdate paths", async () => {
    const fetchMock = captureUrl();
    await sheetsRequest("t", "sheet-1", ":batchUpdate", "POST", { requests: [] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet-1:batchUpdate");
  });

  it("slidesRequest builds a presentations/{id} URL with the given endpoint", async () => {
    const fetchMock = captureUrl();
    await slidesRequest("t", "pres-1", "/pages/p1/thumbnail");
    expect(fetchMock.mock.calls[0][0]).toBe("https://slides.googleapis.com/v1/presentations/pres-1/pages/p1/thumbnail");
  });

  it("appsScriptRequest builds a script API v1 URL", async () => {
    const fetchMock = captureUrl();
    await appsScriptRequest("t", "/projects/proj-1/deployments");
    expect(fetchMock.mock.calls[0][0]).toBe("https://script.googleapis.com/v1/projects/proj-1/deployments");
  });
});
