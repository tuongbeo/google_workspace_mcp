/**
 * Gmail MCP Tools — Full implementation (mirrors taylorwilsdon upstream)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gmailRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

function decodeBase64Url(str: string): string {
  try { return atob(str.replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; }
}

function extractBody(payload: any): string {
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload?.parts || []) {
    if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  }
  // Fallback: HTML-only emails — strip tags to plain text
  for (const part of payload?.parts || []) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = decodeBase64Url(part.body.data);
      return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  for (const part of payload?.parts || []) {
    const r = extractBody(part); if (r) return r;
  }
  return "";
}

function encodeEmail(headers: string, body: string): string {
  const raw = headers + "\r\n" + body;
  return btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function registerGmailTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("search_gmail_messages", "Search Gmail messages using Gmail query syntax.", {
    query: z.string().describe("Gmail query, e.g. 'from:boss@company.com is:unread'"),
    page_size: z.number().optional().default(10),
    page_token: z.string().optional(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, page_size = 10, page_token }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(page_size, 50)) });
    if (page_token) params.set("pageToken", page_token);
    const data = await gmailRequest(accessToken, `/messages?${params}`) as any;
    const messages = data.messages || [];
    if (!messages.length) return { content: [{ type: "text", text: `No messages for: "${query}"` }] };
    const lines = [`Found ${messages.length} messages:`, ""];
    for (const m of messages) lines.push(`ID: ${m.id} | Thread: ${m.threadId} | https://mail.google.com/mail/u/0/#all/${m.id}`);
    if (data.nextPageToken) lines.push(`\nNext page token: ${data.nextPageToken}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("get_gmail_message_content", "Get full content of a Gmail message by ID.", {
    message_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ message_id }) => {
    const { accessToken } = await getCreds();
    const data = await gmailRequest(accessToken, `/messages/${message_id}?format=full`) as any;
    const hdrs: Record<string, string> = {};
    for (const h of data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
    const body = extractBody(data.payload);
    const metaLines = [
      `Subject: ${hdrs.subject || "(none)"}`,
      `From: ${hdrs.from || "?"}`,
      `To: ${hdrs.to || ""}`,
      `Date: ${hdrs.date || ""}`,
      hdrs["message-id"] && `Message-ID: ${hdrs["message-id"]}`,
      hdrs["in-reply-to"] && `In-Reply-To: ${hdrs["in-reply-to"]}`,
      hdrs["references"] && `References: ${hdrs["references"]}`,
      `Labels: ${(data.labelIds || []).join(", ")}`,
    ].filter(Boolean) as string[];
    return { content: [{ type: "text", text: [...metaLines, "", "--- BODY ---", body || "[No readable content]"].join("\n") }] };
  }));

  server.tool("get_gmail_messages_content_batch", "Batch-retrieve full content of multiple Gmail messages.", {
    message_ids: z.array(z.string()).describe("List of message IDs (max 20)"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ message_ids }) => {
    const { accessToken } = await getCreds();
    const results: string[] = [];
    for (const id of message_ids.slice(0, 20)) {
      try {
        const data = await gmailRequest(accessToken, `/messages/${id}?format=full`) as any;
        const hdrs: Record<string, string> = {};
        for (const h of data.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
        results.push(`=== Message ${id} ===\nSubject: ${hdrs.subject || "(none)"}\nFrom: ${hdrs.from || "?"}\nDate: ${hdrs.date || ""}\n${extractBody(data.payload).substring(0, 500)}`);
      } catch (e) { results.push(`=== Message ${id} === ERROR: ${e}`); }
    }
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }));

  server.tool("get_gmail_thread_content", "Get all messages in a Gmail thread.", {
    thread_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ thread_id }) => {
    const { accessToken } = await getCreds();
    const data = await gmailRequest(accessToken, `/threads/${thread_id}?format=full`) as any;
    const messages = data.messages || [];
    const lines = [`Thread ${thread_id} — ${messages.length} message(s)`, ""];
    for (const msg of messages) {
      const hdrs: Record<string, string> = {};
      for (const h of msg.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
      lines.push(`[${hdrs.date || "?"}] From: ${hdrs.from || "?"}`);
      lines.push(`Subject: ${hdrs.subject || "(none)"}`);
      const body = extractBody(msg.payload);
      if (body) lines.push(body.substring(0, 300).trim());
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("send_gmail_message", "Send an email using Gmail.", {
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    in_reply_to_message_id: z.string().optional(),
    html: z.boolean().optional().default(false).describe("Set true to send HTML body"),
  }, withErrorHandler(async ({ to, subject, body, cc, bcc, in_reply_to_message_id, html = false }) => {
    const { accessToken } = await getCreds();
    const contentType = html ? "text/html" : "text/plain";
    let headers = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: ${contentType}; charset=utf-8`;
    if (cc) headers += `\r\nCc: ${cc}`;
    if (bcc) headers += `\r\nBcc: ${bcc}`;
    if (in_reply_to_message_id) headers += `\r\nIn-Reply-To: <${in_reply_to_message_id}>`;
    const payload: Record<string, unknown> = { raw: encodeEmail(headers, body) };
    if (in_reply_to_message_id) {
      const orig = await gmailRequest(accessToken, `/messages/${in_reply_to_message_id}?format=minimal`) as any;
      if (orig?.threadId) payload.threadId = orig.threadId;
    }
    const result = await gmailRequest(accessToken, "/messages/send", "POST", payload) as any;
    return { content: [{ type: "text", text: `Email sent! Message ID: ${result.id}` }] };
  }));

  server.tool("create_gmail_draft", "Create a Gmail draft, with optional reply threading and quoted content.", {
    to: z.string(),
    subject: z.string(),
    body: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    html: z.boolean().optional().default(false).describe("Set true to send HTML body"),
    in_reply_to_message_id: z.string().optional().describe("Gmail message ID to reply to — auto-populates In-Reply-To, References headers and threads the draft correctly"),
    include_quoted_content: z.boolean().optional().default(false).describe("Append the original quoted message below the body (signature renders above quoted block, like a native reply)"),
  }, withErrorHandler(async ({ to, subject, body, cc, bcc, html = false, in_reply_to_message_id, include_quoted_content = false }) => {
    const { accessToken } = await getCreds();
    const contentType = html ? "text/html" : "text/plain";
    let headers = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: ${contentType}; charset=utf-8`;
    if (cc) headers += `\r\nCc: ${cc}`;
    if (bcc) headers += `\r\nBcc: ${bcc}`;

    const payload: Record<string, unknown> = {};
    let finalBody = body;

    if (in_reply_to_message_id) {
      const origMsg = await gmailRequest(accessToken, `/messages/${in_reply_to_message_id}?format=full`) as any;
      const origHdrs: Record<string, string> = {};
      for (const h of origMsg?.payload?.headers || []) origHdrs[h.name.toLowerCase()] = h.value;

      const origMsgId = origHdrs["message-id"] || "";
      const origRefs  = origHdrs["references"] || "";
      if (origMsgId) {
        headers += `\r\nIn-Reply-To: ${origMsgId}`;
        headers += `\r\nReferences: ${origRefs ? `${origRefs} ${origMsgId}` : origMsgId}`;
      }
      if (origMsg?.threadId) payload.threadId = origMsg.threadId;

      if (include_quoted_content) {
        const origBody = extractBody(origMsg.payload);
        const from = origHdrs["from"] || "Unknown";
        const date = origHdrs["date"] || "";
        if (html) {
          finalBody = body + `<br><br><blockquote style="border-left:2px solid #ccc;margin-left:8px;padding-left:8px;color:#666"><b>On ${date}, ${from} wrote:</b><br>${origBody.replace(/\n/g, "<br>")}</blockquote>`;
        } else {
          const quoted = origBody.split("\n").map((l: string) => `> ${l}`).join("\n");
          finalBody = `${body}\n\nOn ${date}, ${from} wrote:\n${quoted}`;
        }
      }
    }

    payload.message = { raw: encodeEmail(headers, finalBody) };
    const result = await gmailRequest(accessToken, "/drafts", "POST", payload) as any;
    return { content: [{ type: "text", text: `Draft created! Draft ID: ${result.id}${in_reply_to_message_id ? " (threaded reply)" : ""}` }] };
  }));

  server.tool("list_gmail_labels", "List all Gmail labels.", {}, { readOnlyHint: true }, withErrorHandler(async () => {
    const { accessToken } = await getCreds();
    const data = await gmailRequest(accessToken, "/labels") as any;
    const labels = (data.labels || []).map((l: any) => `- ${l.name} (ID: ${l.id}, type: ${l.type})`).join("\n");
    return { content: [{ type: "text", text: `Gmail Labels:\n${labels}` }] };
  }));

  server.tool("manage_gmail_label", "Create, update, or delete a Gmail label.", {
    action: z.enum(["create", "update", "delete"]),
    label_id: z.string().optional().describe("Required for update/delete"),
    name: z.string().optional().describe("Label name (required for create/update)"),
    message_list_visibility: z.enum(["show", "hide"]).optional(),
    label_list_visibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ action, label_id, name, message_list_visibility, label_list_visibility }) => {
    const { accessToken } = await getCreds();
    if (action === "create") {
      const body: Record<string, unknown> = { name };
      if (message_list_visibility) body.messageListVisibility = message_list_visibility;
      if (label_list_visibility) body.labelListVisibility = label_list_visibility;
      const result = await gmailRequest(accessToken, "/labels", "POST", body) as any;
      return { content: [{ type: "text", text: `Label created: "${result.name}" (ID: ${result.id})` }] };
    } else if (action === "update") {
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (message_list_visibility) body.messageListVisibility = message_list_visibility;
      if (label_list_visibility) body.labelListVisibility = label_list_visibility;
      const result = await gmailRequest(accessToken, `/labels/${label_id}`, "PATCH", body) as any;
      return { content: [{ type: "text", text: `Label updated: "${result.name}"` }] };
    } else {
      await gmailRequest(accessToken, `/labels/${label_id}`, "DELETE");
      return { content: [{ type: "text", text: `Label ${label_id} deleted.` }] };
    }
  }));

  server.tool("modify_gmail_message", "Modify Gmail message labels (mark read, archive, trash, etc.).", {
    message_id: z.string(),
    add_labels: z.array(z.string()).optional(),
    remove_labels: z.array(z.string()).optional(),
  }, withErrorHandler(async ({ message_id, add_labels = [], remove_labels = [] }) => {
    const { accessToken } = await getCreds();
    await gmailRequest(accessToken, `/messages/${message_id}/modify`, "POST", { addLabelIds: add_labels, removeLabelIds: remove_labels });
    return { content: [{ type: "text", text: `Message ${message_id} labels updated.` }] };
  }));

  server.tool("batch_modify_gmail_message_labels", "Batch modify labels on multiple Gmail messages.", {
    message_ids: z.array(z.string()),
    add_labels: z.array(z.string()).optional(),
    remove_labels: z.array(z.string()).optional(),
  }, withErrorHandler(async ({ message_ids, add_labels = [], remove_labels = [] }) => {
    const { accessToken } = await getCreds();
    await gmailRequest(accessToken, "/messages/batchModify", "POST", { ids: message_ids, addLabelIds: add_labels, removeLabelIds: remove_labels });
    return { content: [{ type: "text", text: `Batch modified ${message_ids.length} messages.` }] };
  }));

  server.tool("get_gmail_attachment", "Download a Gmail message attachment (returns base64 content).", {
    message_id: z.string(),
    attachment_id: z.string(),
  }, withErrorHandler(async ({ message_id, attachment_id }) => {
    const { accessToken } = await getCreds();
    const data = await gmailRequest(accessToken, `/messages/${message_id}/attachments/${attachment_id}`) as any;
    return { content: [{ type: "text", text: `Attachment size: ${data.size} bytes\nData (base64): ${(data.data || "").substring(0, 200)}...` }] };
  }));
}

// ─── Additional tools to match upstream ──────────────────────────────────────

export function registerGmailExtraTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_gmail_threads_content_batch", "Batch-retrieve full content of multiple Gmail threads.", {
    thread_ids: z.array(z.string()).describe("List of thread IDs (max 10)"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ thread_ids }) => {
    const { accessToken } = await getCreds();
    const results: string[] = [];
    for (const id of thread_ids.slice(0, 10)) {
      try {
        const data = await gmailRequest(accessToken, `/threads/${id}?format=full`) as any;
        const messages = data.messages || [];
        const summary = messages.map((msg: any) => {
          const hdrs: Record<string, string> = {};
          for (const h of msg.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
          return `[${hdrs.date || "?"}] ${hdrs.from || "?"}: ${hdrs.subject || "(none)"}`;
        }).join("\n");
        results.push(`=== Thread ${id} (${messages.length} msgs) ===\n${summary}`);
      } catch (e) { results.push(`=== Thread ${id} === ERROR: ${e}`); }
    }
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }));

  server.tool("list_gmail_filters", "List all Gmail filters configured for the account.", {}, { readOnlyHint: true }, withErrorHandler(async () => {
    const { accessToken } = await getCreds();
    const data = await gmailRequest(accessToken, "/settings/filters") as any;
    const filters = data.filter || [];
    if (!filters.length) return { content: [{ type: "text", text: "No filters configured." }] };
    const lines = filters.map((f: any) => {
      const criteria = f.criteria || {};
      const action = f.action || {};
      const c = [criteria.from && `from:${criteria.from}`, criteria.to && `to:${criteria.to}`, criteria.subject && `subject:${criteria.subject}`, criteria.query].filter(Boolean).join(", ");
      const a = [action.addLabelIds?.join(","), action.removeLabelIds?.length && `remove:${action.removeLabelIds.join(",")}`, action.forward && `fwd:${action.forward}`].filter(Boolean).join(", ");
      return `ID: ${f.id}\n  Match: ${c || "(any)"}\n  Action: ${a || "(none)"}`;
    });
    return { content: [{ type: "text", text: `Gmail Filters (${filters.length}):\n\n${lines.join("\n\n")}` }] };
  }));

  server.tool("manage_gmail_filter", "Create or delete a Gmail filter.", {
    action: z.enum(["create", "delete"]),
    filter_id: z.string().optional().describe("Required for delete"),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    query: z.string().optional().describe("Advanced Gmail search query"),
    add_label_ids: z.array(z.string()).optional(),
    remove_label_ids: z.array(z.string()).optional(),
    forward_to: z.string().optional(),
    mark_as_read: z.boolean().optional(),
    archive: z.boolean().optional(),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ action, filter_id, from, to, subject, query, add_label_ids, remove_label_ids, forward_to, mark_as_read, archive }) => {
    const { accessToken } = await getCreds();
    if (action === "delete") {
      await gmailRequest(accessToken, `/settings/filters/${filter_id}`, "DELETE");
      return { content: [{ type: "text", text: `Filter ${filter_id} deleted.` }] };
    }
    const criteria: Record<string, string> = {};
    if (from) criteria.from = from;
    if (to) criteria.to = to;
    if (subject) criteria.subject = subject;
    if (query) criteria.query = query;
    const actionObj: Record<string, unknown> = {};
    const addLabels = [...(add_label_ids || [])];
    const removeLabels = [...(remove_label_ids || [])];
    if (mark_as_read) removeLabels.push("UNREAD");
    if (archive) removeLabels.push("INBOX");
    if (addLabels.length) actionObj.addLabelIds = addLabels;
    if (removeLabels.length) actionObj.removeLabelIds = removeLabels;
    if (forward_to) actionObj.forward = forward_to;
    const result = await gmailRequest(accessToken, "/settings/filters", "POST", { criteria, action: actionObj }) as any;
    return { content: [{ type: "text", text: `Filter created. ID: ${result.id}` }] };
  }));
}
