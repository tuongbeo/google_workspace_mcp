/**
 * Social Agent — Durable Object for the Social worker.
 *
 * Services: Google Chat, Contacts (including manage_contact_groups)
 * Scopes: SCOPES_SOCIAL (chat.messages, chat.spaces, contacts)
 * Token namespace: "social"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { makeGetCreds } from "../../google-tokens";
import { registerChatTools }     from "../../tools/chat";
import { registerContactsTools } from "../../tools/contacts";

export class SocialAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-social",
    version: "1.0.0",
  } as any);

  async init() {
    const sub      = this.props.google_sub;
    const getCreds = makeGetCreds(sub, this.env, "social");

    console.log(`[social-agent] init for sub=${sub}`);

    registerChatTools(this.server, getCreds);
    registerContactsTools(this.server, getCreds);
  }
}
