/**
 * Plan Agent — Durable Object for the Plan worker.
 *
 * Includes: Gmail, Calendar, Tasks, Search tools.
 * Scopes: SCOPES_PLAN (gmail.modify, gmail.send, gmail.settings.basic, calendar, tasks)
 * Token namespace: "plan"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { getValidAccessToken } from "../../google-tokens";

import { registerGmailTools, registerGmailExtraTools } from "../../tools/gmail";
import { registerCalendarTools } from "../../tools/calendar";
import { registerTasksTools, registerTaskListExtraTools } from "../../tools/workspace";
import { registerSearchTools } from "../../tools/search";

export class PlanAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-plan",
    version: "1.0.0",
  } as any);

  async init() {
    const sub = this.props.google_sub;
    const env = this.env;

    console.log(`[plan-agent] init for sub=${sub}, email=${this.props.email}`);

    const getCreds = async () => ({
      accessToken: await getValidAccessToken(
        sub,
        env.TOKENS_KV,
        env.GOOGLE_OAUTH_CLIENT_ID,
        env.GOOGLE_OAUTH_CLIENT_SECRET,
        "plan",
      ),
    });

    // Gmail (~14 tools)
    registerGmailTools(this.server, getCreds);
    registerGmailExtraTools(this.server, getCreds);

    // Calendar (~8 tools)
    registerCalendarTools(this.server, getCreds);

    // Tasks (~10 tools)
    registerTasksTools(this.server, getCreds);
    registerTaskListExtraTools(this.server, getCreds);

    // Search (get_search_engine_info, search_custom, search_custom_siterestrict)
    registerSearchTools(this.server, getCreds, env);
  }
}
