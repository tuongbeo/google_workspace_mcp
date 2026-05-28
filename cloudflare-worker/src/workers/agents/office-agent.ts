/**
 * Office Agent — Durable Object for the Office worker.
 *
 * Includes: Docs, Sheets, Slides, Drive, Forms, AppsScript, composite & consolidated tools.
 * Scopes: SCOPES_OFFICE (drive, documents, spreadsheets, presentations, forms, script.*)
 * Token namespace: "office"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { makeGetCreds } from "../../google-tokens";

// Docs
import { registerDocsTools, registerDocsExtraTools } from "../../tools/docs";
import { registerDocsAdvancedTools } from "../../tools/docs-advanced";
import { registerDocsPhase2Tools } from "../../tools/docs-phase2";
import { registerWriteGoogleDocTool } from "../../tools/write-google-doc";

// Sheets
import { registerSheetsTools, registerSheetsExtraTools } from "../../tools/sheets";
import { registerSheetsPhase2Tools } from "../../tools/sheets-phase2";
import { registerWriteGoogleSheetTool } from "../../tools/write-google-sheet";

// Slides
import { registerSlidesExtendedTools } from "../../tools/slides";
import { registerSlidesPhase2Tools } from "../../tools/slides-phase2";
import {
  registerSlidesTools,
  registerFormsTools,
  registerSlidesPageTools,
  registerFormSettingsTools,
} from "../../tools/workspace";

// Drive
import { registerDriveTools, registerDriveExtraTools } from "../../tools/drive";
import { registerDriveRevisionsTools } from "../../tools/drive-revisions";

// AppsScript
import { registerAppsScriptTools, registerAppsScriptExtraTools } from "../../tools/appsscript";
import { registerAppsScriptPhase2Tools } from "../../tools/appsscript-phase2";

// Composite & Consolidated
import { registerCompositeTools } from "../../tools/composite";
import { registerConsolidatedTools } from "../../tools/consolidated";

export class OfficeAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-office",
    version: "1.0.0",
  } as any);

  async init() {
    const sub = this.props.google_sub;

    console.log(`[office-agent] init for sub=${sub}, email=${this.props.email}`);

    const getCreds = makeGetCreds(sub, this.env, "office");

    // Docs (~20 tools)
    registerDocsTools(this.server, getCreds);
    registerDocsExtraTools(this.server, getCreds);
    registerDocsAdvancedTools(this.server, getCreds);
    registerDocsPhase2Tools(this.server, getCreds);
    registerWriteGoogleDocTool(this.server, getCreds);

    // Sheets (~14 tools)
    registerSheetsTools(this.server, getCreds);
    registerSheetsExtraTools(this.server, getCreds);
    registerSheetsPhase2Tools(this.server, getCreds);
    registerWriteGoogleSheetTool(this.server, getCreds);

    // Slides (~20 tools)
    registerSlidesTools(this.server, getCreds);
    registerSlidesExtendedTools(this.server, getCreds);
    registerSlidesPhase2Tools(this.server, getCreds);
    registerSlidesPageTools(this.server, getCreds);

    // Drive (~18 tools)
    registerDriveTools(this.server, getCreds);
    registerDriveExtraTools(this.server, getCreds);
    registerDriveRevisionsTools(this.server, getCreds);

    // Forms (~7 tools)
    registerFormsTools(this.server, getCreds);
    registerFormSettingsTools(this.server, getCreds);

    // AppsScript (~15 tools)
    registerAppsScriptTools(this.server, getCreds);
    registerAppsScriptExtraTools(this.server, getCreds);
    registerAppsScriptPhase2Tools(this.server, getCreds);

    // Composite (create_rich_doc, import_markdown_as_doc, etc.)
    registerCompositeTools(this.server, getCreds);

    // Consolidated: manage_doc_tabs, manage_named_ranges, manage_doc_comments,
    // manage_doc_suggestions, manage_drive_revisions, manage_script_*,
    // manage_contact_groups (won't work without contacts scope — acceptable)
    registerConsolidatedTools(this.server, getCreds);
  }
}
