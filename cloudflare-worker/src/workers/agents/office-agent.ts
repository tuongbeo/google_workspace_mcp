/**
 * Office Agent — Durable Object for the Office worker.
 *
 * All-in-one Google Workspace agent (replaces workspace + plan + social workers).
 * Services: Docs, Sheets, Slides, Drive, Forms, AppsScript, Tasks,
 *           Gmail, Calendar, Chat, Contacts, Search
 * Scopes:   drive.file (non-sensitive), documents, spreadsheets, presentations,
 *           forms, script.*, tasks, gmail.modify, gmail.send, gmail.settings.basic,
 *           calendar, chat.messages, chat.spaces, contacts
 * Token namespace: "office"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { makeGetCreds } from "../../google-tokens";
import { registerDocsTools }       from "../../tools/docs";
import { registerSheetsTools }     from "../../tools/sheets";
import { registerSlidesTools }     from "../../tools/slides";
import { registerDriveTools }      from "../../tools/drive";
import { registerFormsTools }      from "../../tools/forms";
import { registerAppsScriptTools } from "../../tools/appsscript";
import { registerTasksTools }      from "../../tools/tasks";
import { registerCompositeTools }  from "../../tools/composite";
import { registerGmailTools }      from "../../tools/gmail";
import { registerCalendarTools }   from "../../tools/calendar";
import { registerChatTools }       from "../../tools/chat";
import { registerContactsTools }   from "../../tools/contacts";
import { registerSearchTools }     from "../../tools/search";

// ── Tools excluded from Office Worker (lean set) ──────────────────────────────
//
// Docs — skip duplicates + tools covered by write_google_doc engine
const SKIP_DOCS = new Set([
  "modify_doc_text",           // duplicate of find_and_replace_doc
  "list_document_comments",    // duplicate of manage_doc_comments action=list
  "add_document_comment",      // duplicate of manage_doc_comments action=add
  "reply_to_document_comment", // duplicate of manage_doc_comments action=reply
  "get_doc_tabs",              // duplicate of manage_doc_tabs action=list
  "get_doc_tab_content",       // duplicate of manage_doc_tabs action=get_content
  "update_doc_tab",            // duplicate of manage_doc_tabs action=update
  "create_named_range",        // duplicate of manage_named_ranges action=create
  "list_named_ranges",         // duplicate of manage_named_ranges action=list
  "delete_named_range",        // duplicate of manage_named_ranges action=delete
  "get_doc_suggestions",       // duplicate of manage_doc_suggestions action=list
  "accept_suggestion",         // duplicate of manage_doc_suggestions action=accept
  "reject_suggestion",         // duplicate of manage_doc_suggestions action=reject
  "insert_doc_elements",       // covered by write_google_doc (tables, page break, HR)
  "create_table_with_data",    // covered by write_google_doc (markdown tables)
  "apply_doc_text_style",      // covered by write_google_doc (theme + markdown)
  "insert_person_mention",     // covered by write_google_doc (@[Name](email) syntax)
  "insert_section_break",      // covered by write_google_doc (\pagebreak)
  "insert_footnote",           // covered by write_google_doc ([^1] syntax)
  "insert_inline_image",       // covered by write_google_doc (![alt](url) syntax)
  "update_doc_headers_footers",// covered by write_google_doc (header_text/footer_text)
  "update_document_style",     // covered by write_google_doc (theme auto-applies)
  "delete_paragraph_bullets",  // niche → batch_update_doc
]);

// Sheets — skip deprecated + niche tools covered by engine or batch_update
const SKIP_SHEETS = new Set([
  "create_spreadsheet",           // deprecated → write_google_sheet
  "create_formatted_spreadsheet", // deprecated → write_google_sheet
  "add_protected_range",          // deprecated → batch_update_spreadsheet
  "manage_conditional_formatting",// engine auto-detects + batch_update_spreadsheet
  "manage_data_validation",       // engine auto-detects + batch_update_spreadsheet
  "manage_cell_merge",            // niche → batch_update_spreadsheet
  "manage_sheet_properties",      // niche → batch_update_spreadsheet
  "add_filter_view",              // niche → batch_update_spreadsheet
]);

// Slides — skip create_presentation (superseded by write_google_slide) + low-level wrappers
const SKIP_SLIDES = new Set([
  "create_presentation",          // superseded by write_google_slide
  "update_text_style",            // low-level → batch_update_presentation
  "update_paragraph_alignment",   // low-level → batch_update_presentation
  "update_slide_background",      // low-level → batch_update_presentation
  "update_shape_position",        // low-level → batch_update_presentation
  "update_shape_properties",      // low-level → batch_update_presentation
  "delete_page_element",          // low-level → batch_update_presentation
  "create_shape",                 // low-level → batch_update_presentation
  "create_line",                  // low-level → batch_update_presentation
  "create_table",                 // low-level → batch_update_presentation
  "update_table_cell_text",       // low-level → batch_update_presentation
  "update_table_cell_style",      // low-level → batch_update_presentation
  "insert_table_rows",            // low-level → batch_update_presentation
  "insert_table_columns",         // low-level → batch_update_presentation
  "delete_table_row",             // low-level → batch_update_presentation
  "delete_table_column",          // low-level → batch_update_presentation
  "group_objects",                // niche → batch_update_presentation
  "replace_all_shapes_with_image",// niche → batch_update_presentation
  "get_slide_thumbnail",          // niche
]);

// Drive — skip duplicate revision tools + scope-incompatible tools
const SKIP_DRIVE = new Set([
  "list_drive_revisions",         // duplicate of manage_drive_revisions action=list
  "get_drive_revision",           // duplicate of manage_drive_revisions action=get
  "update_drive_revision",        // duplicate of manage_drive_revisions action=update
  "delete_drive_revision",        // duplicate of manage_drive_revisions action=delete
  "download_drive_revision",      // duplicate of manage_drive_revisions action=download
  "pin_latest_revision",          // duplicate of manage_drive_revisions action=pin
  "get_drive_file_download_url",  // requires drive.readonly scope (incompatible)
  "list_drive_files",             // requires drive.readonly scope (incompatible)
  "search_drive_files",           // requires drive.readonly scope (incompatible)
]);

// AppsScript — skip individual tools duplicated by consolidated manage_* tools
const SKIP_APPSSCRIPT = new Set([
  "list_script_deployments",      // duplicate of manage_script_deployments action=list
  "create_script_deployment",     // duplicate of manage_script_deployments action=create
  "update_script_deployment",     // duplicate of manage_script_deployments action=update
  "delete_script_deployment",     // duplicate of manage_script_deployments action=delete
  "create_script_version",        // duplicate of manage_script_versions action=create
  "get_script_version",           // duplicate of manage_script_versions action=get
  "list_script_versions",         // duplicate of manage_script_versions action=list
]);

// ── Filter wrapper ────────────────────────────────────────────────────────────
//
// Wraps McpServer.tool to skip registrations for names in the skip set.
// All other McpServer methods remain unaffected.

function withSkip(server: McpServer, skip: Set<string>): McpServer {
  if (skip.size === 0) return server;
  const orig = (server as any).tool.bind(server);
  (server as any).tool = (name: string, ...args: any[]) => {
    if (skip.has(name)) {
      console.log(`[office-agent] skipping tool: ${name}`);
      return;
    }
    return orig(name, ...args);
  };
  return server;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class OfficeAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-office",
    version: "1.0.0",
  } as any);

  async init() {
    const sub      = this.props.google_sub;
    const getCreds = makeGetCreds(sub, this.env, "office");
    const preset   = (this.env as any).TOOLS_PRESET ?? "all";
    const load     = (name: string) => preset === "all" || preset === name;

    console.log(`[office-agent] init for sub=${sub}, preset=${preset}`);

    if (load("docs"))
      registerDocsTools(withSkip(this.server, SKIP_DOCS), getCreds);
    if (load("sheets"))
      registerSheetsTools(withSkip(this.server, SKIP_SHEETS), getCreds);
    if (load("slides"))
      registerSlidesTools(withSkip(this.server, SKIP_SLIDES), getCreds);
    if (load("drive"))
      registerDriveTools(withSkip(this.server, SKIP_DRIVE), getCreds);
    if (load("forms"))
      registerFormsTools(this.server, getCreds);
    if (load("appsscript"))
      registerAppsScriptTools(withSkip(this.server, SKIP_APPSSCRIPT), getCreds);
    if (load("tasks"))
      registerTasksTools(this.server, getCreds);
    if (load("gmail"))
      registerGmailTools(this.server, getCreds);
    if (load("calendar"))
      registerCalendarTools(this.server, getCreds);
    if (load("chat"))
      registerChatTools(this.server, getCreds);
    if (load("contacts"))
      registerContactsTools(this.server, getCreds);
    if (load("search"))
      registerSearchTools(this.server, getCreds, this.env);
    registerCompositeTools(this.server, getCreds);
  }
}
