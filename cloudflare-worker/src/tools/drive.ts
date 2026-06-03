/**
 * Google Drive MCP Tools
 * Consolidated from: drive.ts, drive-revisions.ts, consolidated.ts (manage_drive_revisions)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";

// ── Markdown → HTML converter ──────────────────────────────────────────────
// Design tokens from Anthropic DOCX skill:
//   Font: Arial | H1=16pt #111827 | H2=14pt | H3=12pt | body=11pt 1.4x
//   Table: border #D1D5DB, header-bg #F3F4F6, cell padding 6pt 8pt
// text/html upload gives far better Google Docs conversion quality than text/markdown
// BUG-003 FIX: Replaced greedy underscore regex (?<![*_])_(.+?)_(?![*_]) with
// boundary-aware pattern (^|\s)_..._( |$) to avoid corrupting URLs and snake_case.
function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const parts: string[] = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
    '<body style="font-family:Arial,sans-serif;font-size:11pt;color:#111827;line-height:1.4">',
  ];
  let inList: '' | 'ul' | 'ol' = '';
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let tableOpen = false;
  let tableHeaderDone = false;

  const inline = (text: string): string =>
    text
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // BUG-003 FIX: only match _word_ when surrounded by word boundaries,
      // not inside URLs (https://x.com/my_file) or snake_case identifiers.
      .replace(/(^|\s)_([^_\s][^_]*[^_\s])_(?=\s|$)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code style="font-family:\'Courier New\',monospace;background:#F3F4F6;padding:1pt 3pt;font-size:10pt">$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const closeList = () => { if (inList) { parts.push(`</${inList}>`); inList = ''; } };
  const closeTable = () => { if (tableOpen) { parts.push('</tbody></table>'); tableOpen = false; tableHeaderDone = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (!inCodeBlock) { closeList(); closeTable(); inCodeBlock = true; codeLines = []; }
      else {
        const esc = codeLines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        parts.push(`<pre style="font-family:\'Courier New\',monospace;background:#F3F4F6;padding:8pt;font-size:10pt;border-radius:4pt"><code>${esc}</code></pre>`);
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }
    if (line.startsWith('|')) {
      closeList();
      const cells = line.split('|').slice(1,-1).map((c: string)=>c.trim());
      if (cells.every((c: string)=>/^[-: ]+$/.test(c))) { tableHeaderDone = true; continue; }
      if (!tableOpen) { parts.push('<table style="border-collapse:collapse;width:100%;margin:8pt 0;font-size:11pt"><thead>'); tableOpen = true; }
      const isHdr = !tableHeaderDone;
      const tag = isHdr ? 'th' : 'td';
      const cs = isHdr ? 'border:1pt solid #D1D5DB;padding:6pt 8pt;background:#F3F4F6;font-weight:bold;text-align:left' : 'border:1pt solid #D1D5DB;padding:6pt 8pt;text-align:left';
      parts.push(`<tr>${cells.map((c: string)=>`<${tag} style="${cs}">${inline(c)}</${tag}>`).join('')}</tr>`);
      if (isHdr) parts.push('</thead><tbody>');
      continue;
    }
    if (tableOpen && !line.startsWith('|')) closeTable();
    if (line.startsWith('#### ')) { closeList(); parts.push(`<h4 style="font-family:Arial;font-size:11pt;font-weight:bold;color:#374151;margin:8pt 0 4pt">${inline(line.slice(5))}</h4>`); continue; }
    if (line.startsWith('### '))  { closeList(); parts.push(`<h3 style="font-family:Arial;font-size:12pt;font-weight:bold;color:#1F2937;margin:10pt 0 5pt">${inline(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## '))   { closeList(); parts.push(`<h2 style="font-family:Arial;font-size:14pt;font-weight:bold;color:#111827;margin:12pt 0 6pt">${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# '))    { closeList(); parts.push(`<h1 style="font-family:Arial;font-size:16pt;font-weight:bold;color:#111827;margin:16pt 0 8pt">${inline(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('> '))    { closeList(); parts.push(`<blockquote style="border-left:4pt solid #D1D5DB;margin:8pt 0;padding:4pt 12pt;color:#6B7280;font-style:italic">${inline(line.slice(2))}</blockquote>`); continue; }
    if (/^[-*_]{3,}$/.test(line.trim())) { closeList(); parts.push('<hr style="border:none;border-top:1pt solid #D1D5DB;margin:12pt 0">'); continue; }
    if (/^[-*+] /.test(line)) { if (inList!=='ul'){closeList();parts.push('<ul style="margin:4pt 0;padding-left:18pt">');inList='ul';} parts.push(`<li style="margin:3pt 0">${inline(line.slice(2))}</li>`); continue; }
    if (/^\d+\. /.test(line)) { if (inList!=='ol'){closeList();parts.push('<ol style="margin:4pt 0;padding-left:18pt">');inList='ol';} parts.push(`<li style="margin:3pt 0">${inline(line.replace(/^\d+\. /,''))}</li>`); continue; }
    if (!line.trim()) { closeList(); parts.push('<p style="margin:4pt 0"> </p>'); continue; }
    closeList();
    parts.push(`<p style="margin:4pt 0;font-size:11pt">${inline(line)}</p>`);
  }
  closeList(); closeTable();
  parts.push('</body></html>');
  return parts.join('\n');
}

function _registerDriveCore(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("list_drive_files", "List files and folders in Google Drive.", {
    query: z.string().optional(),
    page_size: z.number().optional().default(20),
    page_token: z.string().optional(),
    folder_id: z.string().optional(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, page_size = 20, page_token, folder_id }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,parents),nextPageToken", pageSize: String(Math.min(page_size, 100)) });
    let q = query || "";
    if (folder_id) q = (q ? `(${q}) and ` : "") + `'${folder_id}' in parents`;
    if (q) params.set("q", q);
    if (page_token) params.set("pageToken", page_token);
    const data = await driveRequest(accessToken, `/files?${params}`) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No files found." }] };
    const lines = files.map((f: any) => `📄 ${f.name} (${f.mimeType.split(".").pop()})\n   ID: ${f.id} | Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink || "N/A"}`);
    if (data.nextPageToken) lines.push(`\nNext page: ${data.nextPageToken}`);
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }));

  server.tool("get_drive_file", "Get metadata of a specific Drive file.", {
    file_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ file_id }) => {
    const { accessToken } = await getCreds();
    const data = await driveRequest(accessToken, `/files/${file_id}?fields=id,name,mimeType,size,modifiedTime,createdTime,webViewLink,description,owners,parents`) as any;
    const lines = [`File: ${data.name}`, `ID: ${data.id}`, `Type: ${data.mimeType}`, `Size: ${data.size ? Math.round(data.size / 1024) + " KB" : "N/A"}`, `Created: ${data.createdTime}`, `Modified: ${data.modifiedTime}`, `Link: ${data.webViewLink || "N/A"}`, `Owner: ${data.owners?.map((o: any) => o.emailAddress).join(", ") || "N/A"}`];
    if (data.description) lines.push(`Description: ${data.description}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("search_drive_files", "Search files in Google Drive.", {
    query: z.string(),
    file_type: z.enum(["any", "document", "spreadsheet", "presentation", "pdf", "folder"]).optional().default("any"),
    max_results: z.number().optional().default(10),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, file_type = "any", max_results = 10 }) => {
    const { accessToken } = await getCreds();
    const mimeMap: Record<string, string> = { document: "application/vnd.google-apps.document", spreadsheet: "application/vnd.google-apps.spreadsheet", presentation: "application/vnd.google-apps.presentation", pdf: "application/pdf", folder: "application/vnd.google-apps.folder" };
    let q = `name contains '${query.replace(/'/g, "\\'")}'`;
    if (file_type !== "any") q += ` and mimeType='${mimeMap[file_type]}'`;
    q += " and trashed=false";
    const params = new URLSearchParams({ q, fields: "files(id,name,mimeType,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await driveRequest(accessToken, `/files?${params}`) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: `No files for: "${query}"` }] };
    const lines = files.map((f: any) => `📄 ${f.name}\n   ID: ${f.id}\n   Link: ${f.webViewLink || "N/A"}`);
    return { content: [{ type: "text", text: `Found ${files.length} files:\n\n${lines.join("\n\n")}` }] };
  }));

  server.tool("get_drive_file_content", "Read the text content of a Google Drive file (Docs, Sheets as CSV, plain text files).", {
    file_id: z.string(),
    export_format: z.enum(["text", "html", "markdown", "csv"]).optional().default("text"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ file_id, export_format = "text" }) => {
    const { accessToken } = await getCreds();
    const meta = await driveRequest(accessToken, `/files/${file_id}?fields=id,name,mimeType`) as any;
    const mimeType = meta.mimeType;
    let exportMime = "text/plain";
    if (export_format === "html") exportMime = "text/html";
    else if (export_format === "markdown") exportMime = "text/markdown";
    else if (export_format === "csv") exportMime = "text/csv";

    let content: string;
    if (mimeType.startsWith("application/vnd.google-apps.")) {
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${file_id}/export?mimeType=${encodeURIComponent(exportMime)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) throw new Error(`Export failed: ${await resp.text()}`);
      content = await resp.text();
    } else {
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${file_id}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) throw new Error(`Download failed: ${await resp.text()}`);
      content = await resp.text();
    }
    return { content: [{ type: "text", text: `File: ${meta.name}\n\n${content.substring(0, 10000)}${content.length > 10000 ? "\n\n[Truncated — file is larger than 10,000 chars]" : ""}` }] };
  }));

  server.tool("create_drive_file", "Create a new file in Google Drive, optionally from a URL.", {
    name: z.string(),
    content: z.string().optional().describe("Text content (for plain text files)"),
    mime_type: z.string().optional().default("text/plain"),
    parent_folder_id: z.string().optional(),
    source_url: z.string().optional().describe("Fetch content from this URL"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ name, content, mime_type = "text/plain", parent_folder_id, source_url }) => {
    const { accessToken } = await getCreds();
    let fileContent = content || "";
    if (source_url) {
      const resp = await fetch(source_url);
      if (!resp.ok) throw new Error(`Failed to fetch URL: ${resp.status}`);
      fileContent = await resp.text();
    }
    const metadata: Record<string, unknown> = { name };
    if (parent_folder_id) metadata.parents = [parent_folder_id];
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([fileContent], { type: mime_type }));
    const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
    if (!resp.ok) throw new Error(`Create failed: ${await resp.text()}`);
    const result = await resp.json() as any;
    return { content: [{ type: "text", text: `File created: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  }));


  server.tool("update_drive_file", "Update a Drive file's metadata (name, description, move to folder).", {
    file_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    add_parent: z.string().optional().describe("Add to folder ID"),
    remove_parent: z.string().optional().describe("Remove from folder ID"),
  }, withErrorHandler(async ({ file_id, name, description, add_parent, remove_parent }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (description !== undefined) body.description = description;
    const params = new URLSearchParams({ fields: "id,name" });
    if (add_parent) params.set("addParents", add_parent);
    if (remove_parent) params.set("removeParents", remove_parent);
    const result = await driveRequest(accessToken, `/files/${file_id}?${params}`, "PATCH", body) as any;
    return { content: [{ type: "text", text: `File updated: "${result.name}" (ID: ${result.id})` }] };
  }));

  server.tool("create_drive_folder", "Create a new folder in Google Drive.", {
    title: z.string(),
    parent_folder_id: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title, parent_folder_id }) => {
    const { accessToken } = await getCreds();
    const metadata: Record<string, unknown> = { name: title, mimeType: "application/vnd.google-apps.folder" };
    if (parent_folder_id) metadata.parents = [parent_folder_id];
    const result = await driveRequest(accessToken, "/files?fields=id,name,webViewLink", "POST", metadata) as any;
    return { content: [{ type: "text", text: `Folder created: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  }));

  server.tool("copy_drive_file", "Copy a file in Google Drive.", {
    file_id: z.string(),
    new_title: z.string(),
    destination_folder_id: z.string().optional(),
  }, withErrorHandler(async ({ file_id, new_title, destination_folder_id }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { name: new_title };
    if (destination_folder_id) body.parents = [destination_folder_id];
    const result = await driveRequest(accessToken, `/files/${file_id}/copy?fields=id,name,webViewLink`, "POST", body) as any;
    return { content: [{ type: "text", text: `Copied: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  }));

  server.tool("get_drive_shareable_link", "Get or create a shareable link for a Drive file.", {
    file_id: z.string(),
    permission: z.enum(["reader", "commenter", "writer"]).optional().default("reader"),
  }, withErrorHandler(async ({ file_id, permission = "reader" }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions`, "POST", { role: permission, type: "anyone" });
    const file = await driveRequest(accessToken, `/files/${file_id}?fields=webViewLink`) as any;
    return { content: [{ type: "text", text: `Shareable link (${permission}):\n${file.webViewLink}` }] };
  }));

  server.tool("share_drive_file", "Share a Drive file with a specific user or group.", {
    file_id: z.string(),
    email: z.string().describe("Email of user/group to share with"),
    role: z.enum(["reader", "commenter", "writer", "owner"]).optional().default("reader"),
    type: z.enum(["user", "group", "domain", "anyone"]).optional().default("user"),
    send_notification: z.boolean().optional().default(true),
    email_message: z.string().optional(),
  }, withErrorHandler(async ({ file_id, email, role = "reader", type = "user", send_notification = true, email_message }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { role, type, emailAddress: email };
    const params = new URLSearchParams({ sendNotificationEmail: String(send_notification) });
    if (email_message) params.set("emailMessage", email_message);
    const result = await driveRequest(accessToken, `/files/${file_id}/permissions?${params}`, "POST", body) as any;
    return { content: [{ type: "text", text: `Shared with ${email} as ${role}. Permission ID: ${result.id}` }] };
  }));

  server.tool("get_drive_file_permissions", "Get all permissions on a Drive file.", {
    file_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ file_id }) => {
    const { accessToken } = await getCreds();
    const data = await driveRequest(accessToken, `/files/${file_id}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`) as any;
    const perms = (data.permissions || []).map((p: any) => `- ${p.type}: ${p.emailAddress || p.displayName || "anyone"} | Role: ${p.role} | ID: ${p.id}`);
    return { content: [{ type: "text", text: `Permissions for ${file_id}:\n${perms.join("\n")}` }] };
  }));

  server.tool("update_drive_permission", "Update a permission role on a Drive file.", {
    file_id: z.string(),
    permission_id: z.string(),
    role: z.enum(["reader", "commenter", "writer", "owner"]),
  }, { readOnlyHint: false }, withErrorHandler(async ({ file_id, permission_id, role }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions/${permission_id}`, "PATCH", { role });
    return { content: [{ type: "text", text: `Permission ${permission_id} updated to role: ${role}` }] };
  }));

  server.tool("remove_drive_permission", "Remove a permission from a Drive file.", {
    file_id: z.string(),
    permission_id: z.string(),
  }, withErrorHandler(async ({ file_id, permission_id }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions/${permission_id}`, "DELETE");
    return { content: [{ type: "text", text: `Permission ${permission_id} removed from ${file_id}.` }] };
  }));

  server.tool("transfer_drive_ownership", "Transfer ownership of a Drive file to another Google user. Note: the new owner must be in the same Google Workspace organization for domain-managed files.", {
    file_id: z.string(),
    new_owner_email: z.string().describe("Google account email of the new owner"),
    send_notification: z.boolean().optional().default(true),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ file_id, new_owner_email, send_notification = true }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({
      sendNotificationEmail: String(send_notification),
      transferOwnership: "true",
      fields: "id,role,emailAddress",
    });
    const result = await driveRequest(
      accessToken,
      `/files/${file_id}/permissions?${params}`,
      "POST",
      { role: "owner", type: "user", emailAddress: new_owner_email }
    ) as any;
    return { content: [{ type: "text", text: `Ownership transferred to ${new_owner_email}.\nPermission ID: ${result.id}\nRole: ${result.role}` }] };
  }));

  server.tool("batch_share_drive_file", "Share a Drive file with multiple users at once.", {
    file_id: z.string(),
    recipients: z.array(z.object({ email: z.string(), role: z.enum(["reader", "commenter", "writer"]) })),
    send_notification: z.boolean().optional().default(false),
  }, withErrorHandler(async ({ file_id, recipients, send_notification = false }) => {
    const { accessToken } = await getCreds();
    const results: string[] = [];
    for (const r of recipients) {
      try {
        await driveRequest(accessToken, `/files/${file_id}/permissions?sendNotificationEmail=${send_notification}`, "POST", { role: r.role, type: "user", emailAddress: r.email });
        results.push(`✓ ${r.email} (${r.role})`);
      } catch (e) { results.push(`✗ ${r.email}: ${e}`); }
    }
    return { content: [{ type: "text", text: `Batch share results:\n${results.join("\n")}` }] };
  }));
}

// ─── Additional tools to match upstream ──────────────────────────────────────

function _registerDriveExtra(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_drive_file_download_url", "Get a direct download URL for a Drive file and optionally export Google native files.", {
    file_id: z.string(),
    export_mime_type: z.string().optional().describe("For Google native files: export MIME type, e.g. 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ file_id, export_mime_type }) => {
    const { accessToken } = await getCreds();
    const meta = await driveRequest(accessToken, `/files/${file_id}?fields=id,name,mimeType,size,webContentLink,webViewLink`) as any;
    const lines = [`File: ${meta.name}`, `Type: ${meta.mimeType}`];
    if (meta.webContentLink) lines.push(`Direct download: ${meta.webContentLink}`);
    if (meta.webViewLink) lines.push(`View link: ${meta.webViewLink}`);
    if (meta.mimeType?.startsWith("application/vnd.google-apps.") || export_mime_type) {
      const mime = export_mime_type || "application/pdf";
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${file_id}/export?mimeType=${encodeURIComponent(mime)}`;
      lines.push(`Export as ${mime}:\n${exportUrl}`);
      lines.push("(Requires Authorization header — use with Bearer token)");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("check_drive_file_public_access", "Check the public sharing status of a Drive file.", {
    file_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ file_id }) => {
    const { accessToken } = await getCreds();
    const data = await driveRequest(accessToken, `/files/${file_id}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`) as any;
    const perms = data.permissions || [];
    const publicPerm = perms.find((p: any) => p.type === "anyone");
    const domainPerm = perms.find((p: any) => p.type === "domain");
    const lines = [`File: ${file_id}`, ""];
    if (publicPerm) {
      lines.push(`✅ PUBLIC ACCESS: Anyone can ${publicPerm.role}`);
      lines.push(`Permission ID: ${publicPerm.id}`);
    } else if (domainPerm) {
      lines.push(`🔶 DOMAIN ACCESS: Domain members can ${domainPerm.role}`);
    } else {
      lines.push("🔒 PRIVATE: No public or domain access");
    }
    lines.push(`\nTotal permissions: ${perms.length}`);
    const named = perms.filter((p: any) => p.type === "user" || p.type === "group");
    if (named.length) lines.push(`Named users/groups: ${named.map((p: any) => `${p.emailAddress || p.displayName} (${p.role})`).join(", ")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));
}


function _registerDriveRevisions(server: McpServer, getCreds: GetCredsFunc) {

  server.tool(
    "list_drive_revisions",
    "List all stored revisions of a Google Drive file. Returns revision ID, modification time, " +
    "modifier email, file size, and whether the revision is kept forever. " +
    "Drive auto-purges old revisions unless keepForever is set. " +
    "Works with Google Docs, Sheets, Slides, and binary files.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      page_size: z.number().optional().default(20).describe("Max revisions to return (default 20, max 200)"),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ file_id, page_size = 20 }) => {
      const { accessToken } = await getCreds();
      const params = new URLSearchParams({
        fields: "revisions(id,modifiedTime,lastModifyingUser,size,keepForever,published,mimeType),nextPageToken",
        pageSize: String(Math.min(page_size, 200)),
      });
      const data = await driveRequest(accessToken, `/files/${file_id}/revisions?${params}`) as any;
      const revisions = data.revisions || [];
      if (!revisions.length) {
        return { content: [{ type: "text", text: "No revisions found. Drive may not track revisions for this file type." }] };
      }
      const lines = [`Revisions for file ${file_id} (${revisions.length}):`, ""];
      revisions.forEach((r: any, i: number) => {
        const modifier = r.lastModifyingUser?.emailAddress || r.lastModifyingUser?.displayName || "unknown";
        const size = r.size ? `${Math.round(Number(r.size) / 1024)} KB` : "N/A";
        const flags = [
          r.keepForever ? "keepForever" : "",
          r.published ? "published" : "",
        ].filter(Boolean).join(", ");
        lines.push(`[${i + 1}] ID: ${r.id}`);
        lines.push(`    Modified: ${r.modifiedTime} by ${modifier}`);
        lines.push(`    Size: ${size}${flags ? " | " + flags : ""}`);
        lines.push("");
      });
      if (data.nextPageToken) lines.push(`Next page token: ${data.nextPageToken}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );

  server.tool(
    "get_drive_revision",
    "Get metadata for a specific revision of a Google Drive file. " +
    "Returns modification time, modifier, size, keepForever status, and export links for Google native files. " +
    "Use list_drive_revisions to find revision IDs.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      revision_id: z.string().describe("Revision ID (from list_drive_revisions)"),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ file_id, revision_id }) => {
      const { accessToken } = await getCreds();
      const r = await driveRequest(
        accessToken,
        `/files/${file_id}/revisions/${revision_id}?fields=id,modifiedTime,lastModifyingUser,size,keepForever,published,publishAuto,mimeType,exportLinks`
      ) as any;
      const lines = [
        `Revision ID: ${r.id}`,
        `Modified: ${r.modifiedTime}`,
        `By: ${r.lastModifyingUser?.emailAddress || r.lastModifyingUser?.displayName || "unknown"}`,
        `Size: ${r.size ? Math.round(Number(r.size) / 1024) + " KB" : "N/A"}`,
        `MIME type: ${r.mimeType || "N/A"}`,
        `Keep forever: ${r.keepForever ?? false}`,
        `Published: ${r.published ?? false}`,
      ];
      if (r.exportLinks && Object.keys(r.exportLinks).length) {
        lines.push("\nExport links:");
        for (const [mime, url] of Object.entries(r.exportLinks)) {
          const label = mime.split("/").pop() || mime;
          lines.push(`  ${label}: ${url}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );

  server.tool(
    "update_drive_revision",
    "Update settings for a specific Drive file revision. " +
    "Key use cases: pin a revision so Drive never auto-deletes it (keepForever=true), " +
    "or unpublish a previously published revision. " +
    "Use list_drive_revisions to find revision IDs.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      revision_id: z.string().describe("Revision ID to update"),
      keep_forever: z.boolean().optional().describe("If true, this revision is never auto-purged by Drive. Default: false."),
      published: z.boolean().optional().describe("For Google Docs/Slides/Sheets: whether this revision is published to the web"),
      publish_auto: z.boolean().optional().describe("If published, whether subsequent revisions are auto-published"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ file_id, revision_id, keep_forever, published, publish_auto }) => {
      const { accessToken } = await getCreds();
      const body: Record<string, unknown> = {};
      if (keep_forever !== undefined) body.keepForever = keep_forever;
      if (published !== undefined) body.published = published;
      if (publish_auto !== undefined) body.publishAuto = publish_auto;

      if (!Object.keys(body).length) {
        return { content: [{ type: "text", text: "No changes specified." }] };
      }

      const result = await driveRequest(
        accessToken,
        `/files/${file_id}/revisions/${revision_id}`,
        "PATCH",
        body
      ) as any;

      const changed = Object.keys(body).map(k => `${k}=${JSON.stringify(body[k])}`).join(", ");
      return {
        content: [{
          type: "text",
          text: [
            `Revision ${revision_id} updated.`,
            `Changes: ${changed}`,
            `Current keepForever: ${result.keepForever ?? false}`,
            `Current published: ${result.published ?? false}`,
          ].join("\n"),
        }],
      };
    })
  );

  server.tool(
    "delete_drive_revision",
    "Delete a specific revision of a Google Drive file. " +
    "Only revisions where keepForever=false can be deleted. " +
    "You cannot delete the most recent revision or the only remaining revision. " +
    "Deleted revisions are permanently removed — this cannot be undone.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      revision_id: z.string().describe("Revision ID to delete (must not be the latest revision)"),
    },
    { readOnlyHint: false, destructiveHint: true },
    withErrorHandler(async ({ file_id, revision_id }) => {
      const { accessToken } = await getCreds();
      await driveRequest(accessToken, `/files/${file_id}/revisions/${revision_id}`, "DELETE");
      return {
        content: [{
          type: "text",
          text: `Revision ${revision_id} deleted from file ${file_id}.`,
        }],
      };
    })
  );

  server.tool(
    "download_drive_revision",
    "Download or get an export URL for a specific revision of a Drive file. " +
    "For Google native files (Docs, Sheets, Slides), returns an export URL in the requested format. " +
    "For binary files (PDF, DOCX, images), returns the direct download URL. " +
    "The URL requires an Authorization: Bearer token to download.",
    {
      file_id: z.string().describe("Google Drive file ID"),
      revision_id: z.string().describe("Revision ID (from list_drive_revisions)"),
      export_mime_type: z.string().optional().describe(
        "For Google native files: MIME type to export as. " +
        "e.g. 'application/pdf', 'text/plain', " +
        "'application/vnd.openxmlformats-officedocument.wordprocessingml.document' (docx), " +
        "'text/csv' (sheets). Omit for binary files."
      ),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ file_id, revision_id, export_mime_type }) => {
      const { accessToken } = await getCreds();
      const r = await driveRequest(
        accessToken,
        `/files/${file_id}/revisions/${revision_id}?fields=id,mimeType,exportLinks,size`
      ) as any;

      const lines = [`Revision ${revision_id} of file ${file_id}:`];

      if (r.mimeType?.startsWith("application/vnd.google-apps.")) {
        // Google native file — use export links
        if (export_mime_type && r.exportLinks?.[export_mime_type]) {
          lines.push(`Export URL (${export_mime_type}):`);
          lines.push(r.exportLinks[export_mime_type]);
          lines.push("\nNote: URL requires 'Authorization: Bearer <token>' header to download.");
        } else if (r.exportLinks) {
          lines.push("Available export formats:");
          for (const [mime, url] of Object.entries(r.exportLinks)) {
            const ext = mime.split(".").pop()?.split(";")[0] || mime.split("/").pop() || mime;
            lines.push(`  ${ext}: ${url}`);
          }
        } else {
          lines.push("No export links available for this revision.");
        }
      } else {
        // Binary file — direct download
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file_id}/revisions/${revision_id}?alt=media`;
        lines.push(`Download URL: ${downloadUrl}`);
        lines.push(`Size: ${r.size ? Math.round(Number(r.size) / 1024) + " KB" : "N/A"}`);
        lines.push("\nNote: URL requires 'Authorization: Bearer <token>' header to download.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );

  server.tool(
    "pin_latest_revision",
    "Pin the most recent revision of a Drive file so it is never auto-deleted by Drive. " +
    "Useful for creating a permanent snapshot of the current state before making bulk edits. " +
    "Returns the pinned revision ID and modification time.",
    {
      file_id: z.string().describe("Google Drive file ID"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ file_id }) => {
      const { accessToken } = await getCreds();
      // Get revisions sorted newest-first
      const data = await driveRequest(
        accessToken,
        `/files/${file_id}/revisions?fields=revisions(id,modifiedTime,keepForever)&pageSize=5`
      ) as any;
      const revisions = data.revisions || [];
      if (!revisions.length) {
        return { content: [{ type: "text", text: "No revisions found for this file." }] };
      }
      // Latest revision is the last in the array
      const latest = revisions[revisions.length - 1];
      if (latest.keepForever) {
        return {
          content: [{
            type: "text",
            text: `Latest revision ${latest.id} is already pinned (keepForever=true).\nModified: ${latest.modifiedTime}`,
          }],
        };
      }
      const result = await driveRequest(
        accessToken,
        `/files/${file_id}/revisions/${latest.id}`,
        "PATCH",
        { keepForever: true }
      ) as any;
      return {
        content: [{
          type: "text",
          text: [
            `Latest revision pinned successfully.`,
            `Revision ID: ${result.id}`,
            `Modified: ${result.modifiedTime}`,
            `keepForever: ${result.keepForever}`,
          ].join("\n"),
        }],
      };
    })
  );
}


function _registerDriveConsolidated(server: McpServer, getCreds: GetCredsFunc): void {
  // ── manage_drive_revisions ──────────────────────────────────────────────────
  
    server.tool("manage_drive_revisions",
      "List, get, download, pin, delete, or update revisions of a Google Drive file. Actions: list | get | download | pin | delete | update.",
      {
        action:      z.enum(["list","get","download","pin","delete","update"]),
        file_id:     z.string(),
        revision_id: z.string().optional().describe("Revision ID (get/download/pin/delete/update)"),
        keep_forever: z.boolean().optional().describe("Pin: keep this revision forever (default true)"),
      },
      { readOnlyHint: false },
      withErrorHandler(async ({ action, file_id, revision_id, keep_forever = true }) => {
        const { accessToken } = await getCreds();
        const base = `https://www.googleapis.com/drive/v3/files/${file_id}/revisions`;
  
        if (action === "list") {
          const data = await googleFetch(`${base}?fields=revisions(id,modifiedTime,lastModifyingUser,size,keepForever)`, accessToken) as any;
          const revs = data.revisions || [];
          const lines = revs.map((r: any) => `Rev ${r.id} | ${r.modifiedTime} | By: ${r.lastModifyingUser?.displayName} | Pinned: ${r.keepForever}`);
          return { content: [{ type: "text", text: lines.join("\n") || "No revisions." }] };
        }
  
        if (action === "get") {
          if (!revision_id) throw new Error("revision_id required");
          const r = await googleFetch(`${base}/${revision_id}`, accessToken) as any;
          return { content: [{ type: "text", text: `Rev ${r.id} | ${r.modifiedTime} | Pinned: ${r.keepForever}` }] };
        }
  
        if (action === "download") {
          if (!revision_id) throw new Error("revision_id required");
          const r = await googleFetch(`${base}/${revision_id}?fields=exportLinks,webContentLink`, accessToken) as any;
          const url = r.webContentLink || Object.values(r.exportLinks || {})[0];
          return { content: [{ type: "text", text: `Download URL: ${url}` }] };
        }
  
        if (action === "pin" || action === "update") {
          if (!revision_id) throw new Error("revision_id required");
          const res = await googleFetch(`${base}/${revision_id}`, accessToken, "PATCH", { keepForever: keep_forever }) as any;
          return { content: [{ type: "text", text: `Revision ${res.id} updated. keepForever=${res.keepForever}` }] };
        }
  
        if (action === "delete") {
          if (!revision_id) throw new Error("revision_id required");
          await googleFetch(`${base}/${revision_id}`, accessToken, "DELETE");
          return { content: [{ type: "text", text: `Revision ${revision_id} deleted.` }] };
        }
  
        return { content: [{ type: "text", text: "Unknown action." }] };
      }),
    );
}

// ── Unified entry point ───────────────────────────────────────────────────────

/** Compatible with drive.file scope (files created by this app only). */
export function registerDriveTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerDriveCore(server, getCreds);
  _registerDriveExtra(server, getCreds);
  _registerDriveRevisions(server, getCreds);
  _registerDriveConsolidated(server, getCreds);
}

/** Requires drive or drive.readonly scope. Only register in workspace agent. */
export function registerDriveFullTools(server: McpServer, getCreds: GetCredsFunc): void {
  // list_recent_files, search_drive_files, list_drive_files are registered via registerDriveExtra
  // This function exists for future tools that need full drive scope
}
