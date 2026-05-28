/**
 * Social Agent — Durable Object for the Social worker.
 *
 * Includes: Google Chat, Contacts tools.
 * Scopes: SCOPES_SOCIAL (chat.messages, chat.spaces, contacts)
 * Token namespace: "social"
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, OAuthProps } from "../../types";
import { makeGetCreds } from "../../google-tokens";

import { registerContactsTools, registerContactsExtraTools } from "../../tools/contacts";
import { registerChatTools, registerChatReactionTools } from "../../tools/workspace";
import { registerConsolidatedTools } from "../../tools/consolidated";

// Only the manage_contact_groups tool from consolidated is relevant to Social.
// We register the full consolidated here but the Docs/Drive/Script tools won't
// have the required scopes — they'll error on use (not on registration).
// TODO: split registerConsolidatedTools by service domain.

export class SocialAgent extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({
    name:    "mcp-social",
    version: "1.0.0",
  } as any);

  async init() {
    const sub = this.props.google_sub;

    console.log(`[social-agent] init for sub=${sub}, email=${this.props.email}`);

    const getCreds = makeGetCreds(sub, this.env, "social");

    // Chat (~6 tools)
    registerChatTools(this.server, getCreds);
    registerChatReactionTools(this.server, getCreds);

    // Contacts (~13 tools)
    registerContactsTools(this.server, getCreds);
    registerContactsExtraTools(this.server, getCreds);

    // manage_contact_groups (from consolidated)
    registerConsolidatedTools(this.server, getCreds);
  }
}
