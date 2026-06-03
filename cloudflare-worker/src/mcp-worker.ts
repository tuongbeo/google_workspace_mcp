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
import { makeGetCreds } from "./google-tokens";
import { registerGmailTools } from "./tools/gmail";
import { registerCalendarTools } from "./tools/calendar";
import { registerDriveTools } from "./tools/drive";
import { registerDocsTools } from "./tools/docs";
import { registerSheetsTools } from "./tools/sheets";
import { registerSlidesTools } from "./tools/slides";
import { registerChatTools } from "./tools/chat";
import { registerTasksTools } from "./tools/tasks";
import { registerFormsTools } from "./tools/forms";
import { registerContactsTools } from "./tools/contacts";
import { registerAppsScriptTools } from "./tools/appsscript";
import { registerSearchTools } from "./tools/search";
import { registerCompositeTools } from "./tools/composite";

export class GoogleWorkspaceAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:     "mcp-google-workspace",
    version:  "3.0.0",
    category: "Productivity",
    logoUrl:  "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/3840px-Google_%22G%22_logo.svg.png",
  } as any);

  async init() {
    const sub = this.props.google_sub;
    console.log(`[agent] init for sub=${sub}, email=${this.props.email}`);

    const getCreds = makeGetCreds(sub, this.env);

    registerGmailTools(this.server, getCreds);
    registerCalendarTools(this.server, getCreds);
    registerDriveTools(this.server, getCreds);
    registerDocsTools(this.server, getCreds);
    registerSheetsTools(this.server, getCreds);
    registerSlidesTools(this.server, getCreds);
    registerChatTools(this.server, getCreds);
    registerTasksTools(this.server, getCreds);
    registerFormsTools(this.server, getCreds);
    registerContactsTools(this.server, getCreds);
    registerAppsScriptTools(this.server, getCreds);
    registerSearchTools(this.server, getCreds, this.env);
    registerCompositeTools(this.server, getCreds);
  }
}
