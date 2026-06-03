/**
 * Plan Agent — Durable Object for the Plan worker.
 *
 * Services: Gmail, Calendar, Tasks
 * Scopes: SCOPES_PLAN (gmail.modify, gmail.send, gmail.settings.basic, calendar, tasks)
 * Token namespace: "plan"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { makeGetCreds } from "../../google-tokens";
import { registerGmailTools }    from "../../tools/gmail";
import { registerCalendarTools } from "../../tools/calendar";
import { registerTasksTools }    from "../../tools/tasks";

export class PlanAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-plan",
    version: "1.0.0",
  } as any);

  async init() {
    const sub      = this.props.google_sub;
    const getCreds = makeGetCreds(sub, this.env, "plan");

    console.log(`[plan-agent] init for sub=${sub}`);

    registerGmailTools(this.server, getCreds);
    registerCalendarTools(this.server, getCreds);
    registerTasksTools(this.server, getCreds);
  }
}
