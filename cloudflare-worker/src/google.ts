/**
 * Google REST API client helpers.
 * Dùng Google API v1/v3/v4 trực tiếp qua Bearer token.
 */

export async function googleFetch(
  url: string,
  accessToken: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorDetail = "";
    try { errorDetail = await response.text(); } catch { errorDetail = `HTTP ${response.status}`; }
    throw new Error(`Google API error [${method} ${url}] → ${response.status}: ${errorDetail}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// ── Gmail API ─────────────────────────────────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${GMAIL_BASE}${path}`, accessToken, method, body);
}

// ── Google Calendar API ───────────────────────────────────────────────────────

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export async function calendarRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${CALENDAR_BASE}${path}`, accessToken, method, body);
}

// ── Google Drive API ──────────────────────────────────────────────────────────

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export async function driveRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${DRIVE_BASE}${path}`, accessToken, method, body);
}

// ── Google Docs API ───────────────────────────────────────────────────────────

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";

export async function docsRequest(
  accessToken: string,
  documentId: string,
  method = "GET",
  path = "",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${DOCS_BASE}/${documentId}${path}`, accessToken, method, body);
}

// ── Google Sheets API ─────────────────────────────────────────────────────────

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export async function sheetsRequest(
  accessToken: string,
  spreadsheetId: string,
  path = "",
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${SHEETS_BASE}/${spreadsheetId}${path}`, accessToken, method, body);
}

// ── Google Apps Script API ────────────────────────────────────────────────────

const APPSSCRIPT_BASE = "https://script.googleapis.com/v1";

export async function appsScriptRequest(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  return googleFetch(`${APPSSCRIPT_BASE}${path}`, accessToken, method, body);
}
