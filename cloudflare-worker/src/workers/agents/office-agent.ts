/**
 * Office Agent — Durable Object for the Office worker.
 *
 * Services: Docs, Sheets, Slides, Drive, Forms, AppsScript, Tasks, Composite
 * Scopes: SCOPES_OFFICE (drive.file, documents, spreadsheets, presentations, forms, script.*)
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

export class OfficeAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-office",
    version: "1.0.0",
  } as any);

  async init() {
    const sub    = this.props.google_sub;
    const getCreds = makeGetCreds(sub, this.env, "office");
    const preset   = (this.env as any).TOOLS_PRESET ?? "all";
    const load     = (name: string) => preset === "all" || preset === name;

    console.log(`[office-agent] init for sub=${sub}, preset=${preset}`);

    if (load("docs"))       registerDocsTools(this.server, getCreds);
    if (load("sheets"))     registerSheetsTools(this.server, getCreds);
    if (load("slides"))     registerSlidesTools(this.server, getCreds);
    if (load("drive"))      registerDriveTools(this.server, getCreds);
    if (load("forms"))      registerFormsTools(this.server, getCreds);
    if (load("appsscript")) registerAppsScriptTools(this.server, getCreds);
    if (load("tasks"))      registerTasksTools(this.server, getCreds);
    registerCompositeTools(this.server, getCreds);
  }
}
