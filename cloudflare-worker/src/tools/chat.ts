/**
 * Google Chat MCP Tools
 * Extracted from workspace.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";
import type {
  ChatSpaceListResponse, ChatMessageListResponse, ChatMessage, ChatReaction, ChatAttachment,
} from "./google-api-types";

function _registerChat(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("list_chat_spaces", "List Google Chat spaces the user is in.", {
    page_size: z.number().optional().default(20),
  }, { readOnlyHint: true }, withErrorHandler(async ({ page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://chat.googleapis.com/v1/spaces?pageSize=${page_size}`, accessToken) as ChatSpaceListResponse;
    const spaces = data.spaces || [];
    if (!spaces.length) return { content: [{ type: "text", text: "No Chat spaces found." }] };
    const lines = spaces.map(s => `- ${s.displayName || s.name} (${s.spaceType || "SPACE"}) | ID: ${s.name}`);
    return { content: [{ type: "text", text: `Chat Spaces (${spaces.length}):\n${lines.join("\n")}` }] };
  }));

  server.tool("get_chat_messages", "Get messages from a Google Chat space with optional time and sender filters.", {
    space_name: z.string().describe("Space name in format 'spaces/{spaceId}'"),
    page_size: z.number().optional().default(20),
    filter: z.string().optional().describe("API filter string, e.g. 'createTime > \"2025-01-01T00:00:00Z\"' or 'sender.name = \"users/123\"'"),
    order_by: z.enum(["createTime asc", "createTime desc"]).optional().default("createTime desc"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ space_name, page_size = 20, filter, order_by = "createTime desc" }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ pageSize: String(page_size), orderBy: order_by });
    if (filter) params.set("filter", filter);
    const data = await googleFetch(`https://chat.googleapis.com/v1/${space_name}/messages?${params}`, accessToken) as ChatMessageListResponse;
    const messages = data.messages || [];
    if (!messages.length) return { content: [{ type: "text", text: "No messages." }] };
    const lines = messages.map(m => {
      const sender = m.sender?.displayName || m.sender?.name || "Unknown";
      const text = m.text || "(media/card)";
      const time = m.createTime ? new Date(m.createTime).toLocaleString() : "";
      return `[${time}] ${sender}: ${text}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("send_chat_message", "Send a message to a Google Chat space.", {
    space_name: z.string().describe("Space name like 'spaces/{spaceId}'"),
    text: z.string(),
  }, withErrorHandler(async ({ space_name, text }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://chat.googleapis.com/v1/${space_name}/messages`, accessToken, "POST", { text }) as ChatMessage;
    return { content: [{ type: "text", text: `Message sent! Message name: ${result.name}` }] };
  }));

  server.tool("search_chat_messages", "Search messages across Google Chat spaces, with optional createTime filter.", {
    query: z.string().describe("Full-text search query"),
    page_size: z.number().optional().default(20),
    create_time_after: z.string().optional().describe("ISO 8601 datetime — only return messages after this time, e.g. '2025-01-01T00:00:00Z'"),
    create_time_before: z.string().optional().describe("ISO 8601 datetime — only return messages before this time"),
    space_name: z.string().optional().describe("Limit to a specific space, e.g. 'spaces/{spaceId}'"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, page_size = 20, create_time_after, create_time_before, space_name }) => {
    const { accessToken } = await getCreds();
    const filters: string[] = [];
    if (create_time_after) filters.push(`createTime > "${create_time_after}"`);
    if (create_time_before) filters.push(`createTime < "${create_time_before}"`);
    if (space_name) filters.push(`space = "spaces/${space_name.replace(/^spaces\//, "")}"`);
    const params = new URLSearchParams({ query, pageSize: String(Math.min(page_size, 25)) });
    if (filters.length) params.set("filter", filters.join(" AND "));
    const data = await googleFetch(`https://chat.googleapis.com/v1/spaces/messages:search?${params}`, accessToken) as ChatMessageListResponse;
    const messages = data.messages || [];
    if (!messages.length) return { content: [{ type: "text", text: `No messages found for: "${query}"` }] };
    const lines = messages.map(m =>
      `[${m.createTime}] ${m.sender?.displayName || m.sender?.name}: ${m.text || "(media)"}\nSpace: ${m.space?.name || m.name?.split("/messages/")[0] || "?"}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }));
}

function _registerChatReactions(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("create_chat_reaction", "Add an emoji reaction to a Google Chat message.", {
    message_name: z.string().describe("Message name in format 'spaces/{space}/messages/{message}'"),
    emoji: z.string().describe("Unicode emoji character, e.g. '👍' or '🎉'"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ message_name, emoji }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://chat.googleapis.com/v1/${message_name}/reactions`, accessToken, "POST", {
      emoji: { unicode: emoji }
    }) as ChatReaction;
    return { content: [{ type: "text", text: `Reaction ${emoji} added to message.\nReaction name: ${result.name}` }] };
  }));

  server.tool("download_chat_attachment", "Get metadata and download info for a Google Chat message attachment.", {
    attachment_name: z.string().describe("Attachment resource name, e.g. 'spaces/{space}/messages/{message}/attachments/{attachment}'"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ attachment_name }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://chat.googleapis.com/v1/${attachment_name}`, accessToken) as ChatAttachment;
    const lines = [
      `Attachment: ${data.name}`, `Filename: ${data.contentName || "N/A"}`,
      `Type: ${data.contentType || "N/A"}`, `Size: ${data.attachmentDataRef?.resourceName || "N/A"}`,
    ];
    if (data.downloadUri) lines.push(`Download URL: ${data.downloadUri}`);
    if (data.driveDataRef?.driveFileId) lines.push(`Drive File ID: ${data.driveDataRef.driveFileId}\nView: https://drive.google.com/file/d/${data.driveDataRef.driveFileId}/view`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));
}
export function registerChatTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerChat(server, getCreds);
  _registerChatReactions(server, getCreds);
}
