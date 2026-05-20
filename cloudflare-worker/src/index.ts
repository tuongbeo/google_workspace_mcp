/**
 * MCP Google Workspace — Cloudflare Workers Entry Point
 *
 * Routes:
 *   GET  /health                                → health check
 *   GET  /.well-known/oauth-authorization-server → OAuth discovery
 *   GET  /.well-known/oauth-protected-resource   → Resource metadata
 *   POST /register                               → Dynamic Client Registration
 *   GET  /authorize                              → OAuth authorize (redirect sang Google)
 *   GET  /callback                               → OAuth callback từ Google
 *   POST /token                                  → Exchange auth code → proxy JWT
 *   POST /mcp                                    → MCP Streamable HTTP endpoint (stateless)
 *   GET  /mcp                                    → 405 (SSE not supported in stateless mode)
 */

import { Hono } from "hono";
import { Env } from "./types";
import {
  buildOAuthMetadata,
  buildResourceMetadata,
  handleDCR,
  handleAuthorize,
  handleCallback,
  handleToken,
} from "./oauth";
import { handleMcpRequest } from "./mcp-agent";
import { verifyJWT } from "./jwt";

const app = new Hono<{ Bindings: Env }>();

// ── Tool Registry (static manifest — update when tools are added/removed) ─────
const TOOL_REGISTRY: string[] = [
  // Apps Script
  "create_script_deployment", "create_script_project", "create_script_version",
  "delete_script_deployment", "delete_script_project",
  "get_script_content", "get_script_metrics", "get_script_project", "get_script_version",
  "list_script_deployments", "list_script_processes", "list_script_projects", "list_script_versions",
  "manage_script_deployments", "manage_script_versions", "manage_triggers",
  "run_script_function", "update_script_content", "update_script_deployment",
  // Calendar
  "create_calendar_event", "delete_calendar_event", "get_calendar_event", "get_calendar_events",
  "list_calendars", "query_calendar_freebusy", "respond_to_calendar_event", "update_calendar_event",
  // Chat
  "create_chat_reaction", "download_chat_attachment", "get_chat_messages",
  "list_chat_spaces", "search_chat_messages", "send_chat_message",
  // Contacts
  "create_contact", "create_contact_group", "delete_contact", "delete_contact_group",
  "get_contact", "get_contact_group", "list_contact_groups", "list_contacts",
  "manage_contact_groups", "manage_contacts_batch", "modify_contact_group_members",
  "search_contacts", "update_contact",
  // Docs — core
  "apply_doc_text_style", "batch_update_doc", "delete_table_column", "delete_table_row",
  "export_doc_to_pdf", "find_and_replace_doc", "get_google_doc", "insert_doc_elements",
  "insert_person_mention", "insert_table_columns", "insert_table_rows", "inspect_doc_structure",
  "modify_doc_text", "update_doc_headers_footers", "update_doc_tab", "update_paragraph_alignment",
  "update_table_cell_style", "update_table_cell_text", "update_text_style",
  // Docs — tabs & comments
  "add_document_comment", "get_doc_tab_content", "get_doc_tabs",
  "list_document_comments", "manage_doc_comments", "manage_doc_suggestions", "manage_doc_tabs",
  "reply_to_document_comment", "write_google_doc", "write_google_sheet",
  // Docs — advanced
  "accept_suggestion", "create_named_range", "create_table", "create_table_with_data",
  "delete_named_range", "delete_paragraph_bullets", "get_doc_metadata", "get_doc_suggestions",
  "insert_footnote", "insert_inline_image", "insert_section_break",
  "list_named_ranges", "manage_named_ranges", "manage_table_cells",
  "reject_suggestion", "update_document_style",
  // Drive
  "batch_share_drive_file", "check_drive_file_public_access", "copy_drive_file",
  "create_drive_file", "create_drive_folder", "get_drive_file", "get_drive_file_content",
  "get_drive_file_download_url", "get_drive_file_permissions", "get_drive_shareable_link",
  "list_drive_files", "remove_drive_permission", "search_drive_files",
  "share_drive_file", "transfer_drive_ownership", "update_drive_file", "update_drive_permission",
  // Drive Revisions
  "delete_drive_revision", "download_drive_revision", "get_drive_revision",
  "list_drive_revisions", "manage_drive_revisions", "pin_latest_revision", "update_drive_revision",
  // Forms
  "batch_update_form", "create_form", "get_form", "get_form_response",
  "list_form_responses", "set_form_publish_settings",
  // Gmail
  "batch_modify_gmail_message_labels", "create_gmail_draft", "get_gmail_attachment",
  "get_gmail_message_content", "get_gmail_messages_content_batch",
  "get_gmail_thread_content", "get_gmail_threads_content_batch",
  "list_gmail_filters", "list_gmail_labels", "manage_gmail_filter", "manage_gmail_label",
  "modify_gmail_message", "search_gmail_messages", "send_gmail_message",
  // Search
  "get_search_engine_info", "search_custom", "search_custom_siterestrict", "search_docs",
  // Sheets — core
  "append_sheet_values", "batch_update_spreadsheet", "create_formatted_spreadsheet",
  "create_sheet", "create_spreadsheet", "format_sheet_range", "get_spreadsheet_info",
  "list_spreadsheets", "read_sheet_values", "write_sheet_values",
  // Sheets — phase 2
  "add_filter_view", "add_protected_range", "create_pivot_table",
  "manage_cell_merge", "manage_charts", "manage_conditional_formatting",
  "manage_data_validation", "manage_sheet_properties", "sort_range",
  // Slides — core
  "add_slide", "add_text_to_slide", "batch_update_presentation", "create_presentation",
  "create_presentation_from_outline", "delete_page_element", "delete_slide",
  "duplicate_slide", "get_presentation", "get_slide_notes", "get_slide_page",
  "get_slide_thumbnail", "insert_image", "reorder_slides", "replace_all_shapes_with_image",
  "replace_all_text", "set_slide_notes", "update_shape_position", "update_slide_background",
  // Slides — phase 2
  "create_line", "create_shape", "group_objects", "update_shape_properties",
  // Tasks
  "clear_completed_tasks", "create_task", "create_task_list", "delete_task", "delete_task_list",
  "get_task", "get_task_list", "list_task_lists", "list_tasks", "move_task", "update_task",
];

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "mcp-google-workspace",
    version: "1.0.0",
    transport: "streamable-http-stateless",
    timestamp: new Date().toISOString(),
  })
);

// ── Tools Manifest (public — no auth required) ────────────────────────────────
app.get("/tools-manifest", (c) =>
  c.json({
    server: "google_workspace",
    version: "1.0.0",
    tool_count: TOOL_REGISTRY.length,
    tools: TOOL_REGISTRY,
  })
);

// ── OAuth Discovery ───────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(buildOAuthMetadata(c.env.PUBLIC_BASE_URL));
});

app.get("/.well-known/oauth-protected-resource", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(buildResourceMetadata(c.env.PUBLIC_BASE_URL));
});

// ── Dynamic Client Registration ───────────────────────────────────────────────
app.post("/register", async (c) => handleDCR(c.req.raw, c.env));

// ── OAuth Flow ────────────────────────────────────────────────────────────────
app.get("/authorize", async (c) => handleAuthorize(c.req.raw, c.env));
app.get("/callback", async (c) => handleCallback(c.req.raw, c.env));
app.post("/token", async (c) => handleToken(c.req.raw, c.env));

// ── MCP Endpoint (Streamable HTTP — stateless) ────────────────────────────────

// BUG-002 FIX: Handle OPTIONS preflight BEFORE auth check.
// Without this, browser-based MCP clients receive 401 on preflight and abort.
app.options("/mcp", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      "Access-Control-Max-Age": "86400",
    },
  });
});

// SSE keep-alive for GET /mcp — replaces BUG-003's 405 response.
//
// Background: BUG-003 blocked GET /mcp with 405 to prevent the "SSE stream
// opens then immediately closes" issue caused by per-request McpServer.close().
// However, Claude.ai's MCP proxy uses GET /mcp SSE as a keep-alive signal.
// Without it, the proxy's internal session timer fires and disconnects.
// Jira/Confluence servers allow GET /mcp → SSE → no disconnect.
//
// Fix: Return a lightweight SSE stream that stays open WITHOUT going through
// the per-request McpServer. This is just a heartbeat — no MCP messages flow
// over it. The stream remains open until the client disconnects.
app.get("/mcp", async (c) => {
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": [
          `Bearer realm="${c.env.PUBLIC_BASE_URL}"`,
          `resource_metadata_url="${c.env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
        ].join(", "),
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET, 86400);
  if (!payload) {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="${c.env.PUBLIC_BASE_URL}", error="invalid_token"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  console.log(`[route] GET /mcp — SSE keep-alive opened for sub=${payload.sub}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Initial comment to confirm connection is alive
      controller.enqueue(encoder.encode(":ok\n\n"));
    },
    cancel() {
      console.log(`[route] GET /mcp — SSE keep-alive closed by client for sub=${payload.sub}`);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    },
  });
});

// Also reject DELETE /mcp — session termination is not needed in stateless mode.
app.delete("/mcp", (c) => new Response(null, {
  status: 405,
  headers: { "Allow": "POST, OPTIONS" },
}));

app.all("/mcp", async (c) => {
  const env = c.env;
  const method = c.req.method;
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  // Không có token → 401 kèm WWW-Authenticate để Claude.ai trigger OAuth discovery
  if (!token) {
    console.log(`[route] ${method} /mcp — no token → 401`);
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": [
          `Bearer realm="${env.PUBLIC_BASE_URL}"`,
          `resource_metadata_url="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
        ].join(", "),
      },
    });
  }

  // Validate proxy JWT — 24h grace period for Claude.ai proxy bug (Anthropic #228)
  const payload = await verifyJWT(token, env.JWT_SECRET, 86400);
  if (!payload) {
    console.warn(`[route] ${method} /mcp — invalid/expired JWT → 401`);
    return new Response(
      JSON.stringify({
        error: "invalid_token",
        error_description: "Token is invalid or expired. Please re-authorize.",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": [
            `Bearer realm="${env.PUBLIC_BASE_URL}"`,
            `error="invalid_token"`,
            `resource_metadata_url="${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
          ].join(", "),
        },
      }
    );
  }

  // Delegate sang MCP handler
  return handleMcpRequest(c.req.raw, env);
});

// ── 404 Fallback ──────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      available_endpoints: [
        "GET /health",
        "GET /tools-manifest",
        "GET /.well-known/oauth-authorization-server",
        "GET /.well-known/oauth-protected-resource",
        "POST /register",
        "GET /authorize",
        "GET /callback",
        "POST /token",
        "POST /mcp",
      ],
    },
    404
  )
);

export default app;
