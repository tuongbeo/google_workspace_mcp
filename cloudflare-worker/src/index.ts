/**
 * Google Workspace MCP Server — Entry Point v3.0
 *
 * Architecture: OAuthProvider + McpAgent (Durable Object)
 *   - OAuthProvider handles all OAuth protocol (DCR, authorize, token, refresh)
 *   - GoogleWorkspaceAgent (McpAgent/DO) handles MCP over WebSocket + hibernation
 *   - No idle timeout, no session timer, no hand-rolled JWT
 *
 * Routes (managed by OAuthProvider):
 *   POST /register                           → Dynamic Client Registration
 *   GET  /authorize                          → OAuth start → Google
 *   GET  /callback                           → OAuth callback from Google
 *   POST /token                              → Token exchange & refresh
 *   ALL  /mcp                                → McpAgent Durable Object
 *
 * Routes (manual):
 *   GET  /health                             → health check
 *   GET  /tools-manifest                     → public tool list
 *   GET  /.well-known/oauth-protected-resource
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./types";
import { GoogleWorkspaceAgent } from "./mcp-worker";
import { GoogleHandler } from "./auth/google";

// ── Tool registry (static — update when tools change) ─────────────────────────
const TOOL_REGISTRY: string[] = [
  "create_script_deployment","create_script_project","create_script_version",
  "delete_script_deployment","delete_script_project","get_script_content",
  "get_script_metrics","get_script_project","get_script_version",
  "list_script_deployments","list_script_processes","list_script_projects",
  "list_script_versions","manage_script_deployments","manage_script_versions",
  "manage_triggers","run_script_function","update_script_content","update_script_deployment",
  "create_calendar_event","delete_calendar_event","get_calendar_event","get_calendar_events",
  "list_calendars","query_calendar_freebusy","respond_to_calendar_event","update_calendar_event",
  "create_chat_reaction","download_chat_attachment","get_chat_messages",
  "list_chat_spaces","search_chat_messages","send_chat_message",
  "create_contact","create_contact_group","delete_contact","delete_contact_group",
  "get_contact","get_contact_group","list_contact_groups","list_contacts",
  "manage_contact_groups","manage_contacts_batch","modify_contact_group_members",
  "search_contacts","update_contact",
  "apply_doc_text_style","batch_update_doc","delete_table_column","delete_table_row",
  "export_doc_to_pdf","find_and_replace_doc","get_google_doc","insert_doc_elements",
  "insert_person_mention","insert_table_columns","insert_table_rows","inspect_doc_structure",
  "modify_doc_text","update_doc_headers_footers","update_doc_tab","update_paragraph_alignment",
  "update_table_cell_style","update_table_cell_text","update_text_style",
  "add_document_comment","get_doc_tab_content","get_doc_tabs","list_document_comments",
  "manage_doc_comments","manage_doc_suggestions","manage_doc_tabs",
  "reply_to_document_comment","write_google_doc",
  "accept_suggestion","create_named_range","create_table","create_table_with_data",
  "delete_named_range","delete_paragraph_bullets","get_doc_metadata","get_doc_suggestions",
  "insert_footnote","insert_inline_image","insert_section_break",
  "list_named_ranges","manage_named_ranges","manage_table_cells","reject_suggestion",
  "update_document_style",
  "batch_share_drive_file","check_drive_file_public_access","copy_drive_file",
  "create_drive_file","create_drive_folder","get_drive_file","get_drive_file_content",
  "get_drive_file_download_url","get_drive_file_permissions","get_drive_shareable_link",
  "list_drive_files","remove_drive_permission","search_drive_files","share_drive_file",
  "transfer_drive_ownership","update_drive_file","update_drive_permission",
  "delete_drive_revision","download_drive_revision","get_drive_revision",
  "list_drive_revisions","manage_drive_revisions","pin_latest_revision","update_drive_revision",
  "batch_update_form","create_form","get_form","get_form_response",
  "list_form_responses","set_form_publish_settings",
  "batch_modify_gmail_message_labels","create_gmail_draft","get_gmail_attachment",
  "get_gmail_message_content","get_gmail_messages_content_batch",
  "get_gmail_thread_content","get_gmail_threads_content_batch",
  "list_gmail_filters","list_gmail_labels","manage_gmail_filter","manage_gmail_label",
  "modify_gmail_message","search_gmail_messages","send_gmail_message",
  "get_search_engine_info","search_custom","search_custom_siterestrict","search_docs",
  "append_sheet_values","batch_update_spreadsheet","create_formatted_spreadsheet",
  "create_sheet","create_spreadsheet","format_sheet_range","get_spreadsheet_info",
  "list_spreadsheets","read_sheet_values","write_sheet_values",
  "add_filter_view","add_protected_range","create_pivot_table","manage_cell_merge",
  "manage_charts","manage_conditional_formatting","manage_data_validation",
  "manage_sheet_properties","sort_range",
  "add_slide","add_text_to_slide","batch_update_presentation","create_presentation",
  "create_presentation_from_outline","delete_page_element","delete_slide",
  "duplicate_slide","get_presentation","get_slide_notes","get_slide_page",
  "get_slide_thumbnail","insert_image","reorder_slides","replace_all_shapes_with_image",
  "replace_all_text","set_slide_notes","update_shape_position","update_slide_background",
  "create_line","create_shape","group_objects","update_shape_properties",
  "clear_completed_tasks","create_task","create_task_list","delete_task","delete_task_list",
  "get_task","get_task_list","list_task_lists","list_tasks","move_task","update_task",
];

// ── Manual routes (health, manifest, protected-resource) ──────────────────────
const router = new Hono<{ Bindings: Env }>();

router.get("/health", (c) => c.json({
  status: "ok",
  service: "mcp-google-workspace",
  version: "3.0.0",
  transport: "websocket-durable-object",
  timestamp: new Date().toISOString(),
}));

router.get("/tools-manifest", (c) => c.json({
  server: "google_workspace",
  version: "3.0.0",
  tool_count: TOOL_REGISTRY.length,
  tools: TOOL_REGISTRY,
}));

router.get("/.well-known/oauth-protected-resource", (c) => {
  const base = c.env.PUBLIC_BASE_URL;
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    resource:                 `${base}/mcp`,
    authorization_servers:    [base],
    scopes_supported:         ["openid", "email"],
    bearer_methods_supported: ["header"],
  });
});

// ── OAuthProvider wraps McpAgent + GoogleHandler ───────────────────────────────
const oauthProvider = new OAuthProvider({
  apiRoute:                    "/mcp",
  apiHandler:                  GoogleWorkspaceAgent.serve("/mcp", { binding: "GW_SERVER" }),
  defaultHandler:              GoogleHandler,
  authorizeEndpoint:           "/authorize",
  tokenEndpoint:               "/token",
  clientRegistrationEndpoint:  "/register",
});

// ── Main export ────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Manual routes: health, tools-manifest, protected-resource metadata
    if (
      url.pathname === "/health" ||
      url.pathname === "/tools-manifest" ||
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return router.fetch(request, env, ctx);
    }

    // Everything else — OAuth (authorize, callback, token, register) + MCP
    // — handled entirely by OAuthProvider. No interception, no hand-rolled logic.
    // This mirrors ClearSpec exactly: OAuthProvider owns all OAuth state and
    // token lifecycle including refresh_token grant. Intercepting /token consumed
    // the request body stream making OAuthProvider receive an empty body → invalid_grant.
    return oauthProvider.fetch(request, env, ctx);
  },
};

// Export DO class (required by Cloudflare)
export { GoogleWorkspaceAgent };
