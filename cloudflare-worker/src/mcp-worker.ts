/**
 * Google Workspace MCP Agent — McpAgent (Durable Object)
 *
 * Replaces per-request McpServer pattern.
 * Durable Object lifecycle:
 *   - One DO instance per user session (keyed by google_sub)
 *   - Persistent WebSocket + DO hibernation → no idle timeout
 *   - init() runs once per connection; tools registered once
 *   - getCreds fetches from TOKENS_KV on each tool call (with auto-refresh)
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "./types";
import { getValidAccessToken } from "./google-tokens";
import { registerGmailTools, registerGmailExtraTools } from "./tools/gmail";
import { registerCalendarTools } from "./tools/calendar";
import { registerDriveTools, registerDriveExtraTools } from "./tools/drive";
import { registerDocsTools, registerDocsExtraTools } from "./tools/docs";
import { registerSheetsTools, registerSheetsExtraTools } from "./tools/sheets";
import { registerContactsTools, registerContactsExtraTools } from "./tools/contacts";
import { registerAppsScriptTools, registerAppsScriptExtraTools } from "./tools/appsscript";
import { registerSearchTools } from "./tools/search";
import { registerSlidesExtendedTools } from "./tools/slides";
import { registerDocsAdvancedTools } from "./tools/docs-advanced";
import { registerDriveRevisionsTools } from "./tools/drive-revisions";
import { registerCompositeTools } from "./tools/composite";
import { registerSheetsPhase2Tools } from "./tools/sheets-phase2";
import { registerDocsPhase2Tools } from "./tools/docs-phase2";
import { registerSlidesPhase2Tools } from "./tools/slides-phase2";
import { registerAppsScriptPhase2Tools } from "./tools/appsscript-phase2";
import { registerConsolidatedTools } from "./tools/consolidated";
import { registerWriteGoogleDocTool } from "./tools/write-google-doc";
import { registerWriteGoogleSheetTool } from "./tools/write-google-sheet";
import {
  registerSlidesTools,
  registerChatTools,
  registerTasksTools,
  registerFormsTools,
  registerWorkspaceExtraTools,
} from "./tools/workspace";

export class GoogleWorkspaceAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:     "mcp-google-workspace",
    version:  "3.0.0",
    category: "Productivity",
    logoUrl:  "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/3840px-Google_%22G%22_logo.svg.png",
  } as any);

  async init() {
    const sub = this.props.google_sub;
    const env = this.env;

    console.log(`[agent] init for sub=${sub}, email=${this.props.email}`);

    // getCreds is called by each tool handler — fetches/refreshes token lazily
    const getCreds = async () => ({
      accessToken: await getValidAccessToken(
        sub,
        env.TOKENS_KV,
        env.GOOGLE_OAUTH_CLIENT_ID,
        env.GOOGLE_OAUTH_CLIENT_SECRET,
      ),
    });

    // Register all 191 tools (same as before)
    registerGmailTools(this.server, getCreds);
    registerGmailExtraTools(this.server, getCreds);
    registerCalendarTools(this.server, getCreds);
    registerDriveTools(this.server, getCreds);
    registerDriveExtraTools(this.server, getCreds);
    registerDocsTools(this.server, getCreds);
    registerDocsExtraTools(this.server, getCreds);
    registerSheetsTools(this.server, getCreds);
    registerSheetsExtraTools(this.server, getCreds);
    registerSlidesTools(this.server, getCreds);
    registerSlidesExtendedTools(this.server, getCreds);
    registerChatTools(this.server, getCreds);
    registerTasksTools(this.server, getCreds);
    registerFormsTools(this.server, getCreds);
    registerContactsTools(this.server, getCreds);
    registerContactsExtraTools(this.server, getCreds);
    registerAppsScriptTools(this.server, getCreds);
    registerAppsScriptExtraTools(this.server, getCreds);
    registerSearchTools(this.server, getCreds, env);
    registerWorkspaceExtraTools(this.server, getCreds);
    registerDocsAdvancedTools(this.server, getCreds);
    registerDriveRevisionsTools(this.server, getCreds);
    registerCompositeTools(this.server, getCreds);
    registerSheetsPhase2Tools(this.server, getCreds);
    registerDocsPhase2Tools(this.server, getCreds);
    registerSlidesPhase2Tools(this.server, getCreds);
    registerAppsScriptPhase2Tools(this.server, getCreds);
    registerConsolidatedTools(this.server, getCreds);
    registerWriteGoogleDocTool(this.server, getCreds);
    registerWriteGoogleSheetTool(this.server, getCreds);
  }
}
