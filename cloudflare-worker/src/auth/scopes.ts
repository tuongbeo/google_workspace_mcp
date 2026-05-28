/**
 * OAuth scope definitions per worker.
 *
 * Each worker requests only the scopes it needs.
 * Google Consent Screen in Cloud Console declares the superset of all scopes;
 * at runtime, each worker requests its own subset.
 */

export const SCOPES_OFFICE = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.metrics",
  "https://www.googleapis.com/auth/script.deployments",
];

export const SCOPES_PLAN = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
];

export const SCOPES_SOCIAL = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/contacts",
];

// Workspace = superset of all scopes, deduplicated
export const SCOPES_WORKSPACE = [
  ...SCOPES_OFFICE,
  ...SCOPES_PLAN,
  ...SCOPES_SOCIAL,
].filter((v, i, a) => a.indexOf(v) === i);
