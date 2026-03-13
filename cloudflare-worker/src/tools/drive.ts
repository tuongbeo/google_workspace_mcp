/**
 * Google Drive MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { driveRequest, googleFetch } from "../google";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerDriveTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("list_drive_files", "List files and folders in Google Drive.", {
    query: z.string().optional(),
    page_size: z.number().optional().default(20),
    page_token: z.string().optional(),
    folder_id: z.string().optional(),
  }, async ({ query, page_size = 20, page_token, folder_id }) => {
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
  });

  server.tool("get_drive_file", "Get metadata of a specific Drive file.", {
    file_id: z.string(),
  }, async ({ file_id }) => {
    const { accessToken } = await getCreds();
    const data = await driveRequest(accessToken, `/files/${file_id}?fields=id,name,mimeType,size,modifiedTime,createdTime,webViewLink,description,owners,parents`) as any;
    const lines = [`File: ${data.name}`, `ID: ${data.id}`, `Type: ${data.mimeType}`, `Size: ${data.size ? Math.round(data.size / 1024) + " KB" : "N/A"}`, `Created: ${data.createdTime}`, `Modified: ${data.modifiedTime}`, `Link: ${data.webViewLink || "N/A"}`, `Owner: ${data.owners?.map((o: any) => o.emailAddress).join(", ") || "N/A"}`];
    if (data.description) lines.push(`Description: ${data.description}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("search_drive_files", "Search files in Google Drive.", {
    query: z.string(),
    file_type: z.enum(["any", "document", "spreadsheet", "presentation", "pdf", "folder"]).optional().default("any"),
    max_results: z.number().optional().default(10),
  }, async ({ query, file_type = "any", max_results = 10 }) => {
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
  });

  server.tool("get_drive_file_content", "Read the text content of a Google Drive file (Docs, Sheets as CSV, plain text files).", {
    file_id: z.string(),
    export_format: z.enum(["text", "html", "markdown", "csv"]).optional().default("text"),
  }, async ({ file_id, export_format = "text" }) => {
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
  });

  server.tool("create_drive_file", "Create a new file in Google Drive, optionally from a URL.", {
    name: z.string(),
    content: z.string().optional().describe("Text content (for plain text files)"),
    mime_type: z.string().optional().default("text/plain"),
    parent_folder_id: z.string().optional(),
    source_url: z.string().optional().describe("Fetch content from this URL"),
  }, async ({ name, content, mime_type = "text/plain", parent_folder_id, source_url }) => {
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
  });

  server.tool("import_to_google_doc", "Import a text/markdown file as a Google Doc.", {
    name: z.string(),
    content: z.string().describe("Markdown or plain text content"),
    parent_folder_id: z.string().optional(),
  }, async ({ name, content, parent_folder_id }) => {
    const { accessToken } = await getCreds();
    const metadata: Record<string, unknown> = { name, mimeType: "application/vnd.google-apps.document" };
    if (parent_folder_id) metadata.parents = [parent_folder_id];
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([content], { type: "text/markdown" }));
    const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form });
    if (!resp.ok) throw new Error(`Import failed: ${await resp.text()}`);
    const result = await resp.json() as any;
    return { content: [{ type: "text", text: `Imported as Google Doc: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  });

  server.tool("update_drive_file", "Update a Drive file's metadata (name, description, move to folder).", {
    file_id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    add_parent: z.string().optional().describe("Add to folder ID"),
    remove_parent: z.string().optional().describe("Remove from folder ID"),
  }, async ({ file_id, name, description, add_parent, remove_parent }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (description !== undefined) body.description = description;
    const params = new URLSearchParams({ fields: "id,name" });
    if (add_parent) params.set("addParents", add_parent);
    if (remove_parent) params.set("removeParents", remove_parent);
    const result = await driveRequest(accessToken, `/files/${file_id}?${params}`, "PATCH", body) as any;
    return { content: [{ type: "text", text: `File updated: "${result.name}" (ID: ${result.id})` }] };
  });

  server.tool("create_drive_folder", "Create a new folder in Google Drive.", {
    title: z.string(),
    parent_folder_id: z.string().optional(),
  }, async ({ title, parent_folder_id }) => {
    const { accessToken } = await getCreds();
    const metadata: Record<string, unknown> = { name: title, mimeType: "application/vnd.google-apps.folder" };
    if (parent_folder_id) metadata.parents = [parent_folder_id];
    const result = await driveRequest(accessToken, "/files?fields=id,name,webViewLink", "POST", metadata) as any;
    return { content: [{ type: "text", text: `Folder created: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  });

  server.tool("copy_drive_file", "Copy a file in Google Drive.", {
    file_id: z.string(),
    new_title: z.string(),
    destination_folder_id: z.string().optional(),
  }, async ({ file_id, new_title, destination_folder_id }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { name: new_title };
    if (destination_folder_id) body.parents = [destination_folder_id];
    const result = await driveRequest(accessToken, `/files/${file_id}/copy?fields=id,name,webViewLink`, "POST", body) as any;
    return { content: [{ type: "text", text: `Copied: "${result.name}"\nID: ${result.id}\nLink: ${result.webViewLink}` }] };
  });

  server.tool("get_drive_shareable_link", "Get or create a shareable link for a Drive file.", {
    file_id: z.string(),
    permission: z.enum(["reader", "commenter", "writer"]).optional().default("reader"),
  }, async ({ file_id, permission = "reader" }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions`, "POST", { role: permission, type: "anyone" });
    const file = await driveRequest(accessToken, `/files/${file_id}?fields=webViewLink`) as any;
    return { content: [{ type: "text", text: `Shareable link (${permission}):\n${file.webViewLink}` }] };
  });

  server.tool("share_drive_file", "Share a Drive file with a specific user or group.", {
    file_id: z.string(),
    email: z.string().describe("Email of user/group to share with"),
    role: z.enum(["reader", "commenter", "writer", "owner"]).optional().default("reader"),
    type: z.enum(["user", "group", "domain", "anyone"]).optional().default("user"),
    send_notification: z.boolean().optional().default(true),
    email_message: z.string().optional(),
  }, async ({ file_id, email, role = "reader", type = "user", send_notification = true, email_message }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { role, type, emailAddress: email };
    const params = new URLSearchParams({ sendNotificationEmail: String(send_notification) });
    if (email_message) params.set("emailMessage", email_message);
    const result = await driveRequest(accessToken, `/files/${file_id}/permissions?${params}`, "POST", body) as any;
    return { content: [{ type: "text", text: `Shared with ${email} as ${role}. Permission ID: ${result.id}` }] };
  });

  server.tool("get_drive_file_permissions", "Get all permissions on a Drive file.", {
    file_id: z.string(),
  }, async ({ file_id }) => {
    const { accessToken } = await getCreds();
    const data = await driveRequest(accessToken, `/files/${file_id}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`) as any;
    const perms = (data.permissions || []).map((p: any) => `- ${p.type}: ${p.emailAddress || p.displayName || "anyone"} | Role: ${p.role} | ID: ${p.id}`);
    return { content: [{ type: "text", text: `Permissions for ${file_id}:\n${perms.join("\n")}` }] };
  });

  server.tool("update_drive_permission", "Update a permission role on a Drive file.", {
    file_id: z.string(),
    permission_id: z.string(),
    role: z.enum(["reader", "commenter", "writer", "owner"]),
  }, async ({ file_id, permission_id, role }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions/${permission_id}`, "PATCH", { role });
    return { content: [{ type: "text", text: `Permission ${permission_id} updated to role: ${role}` }] };
  });

  server.tool("remove_drive_permission", "Remove a permission from a Drive file.", {
    file_id: z.string(),
    permission_id: z.string(),
  }, async ({ file_id, permission_id }) => {
    const { accessToken } = await getCreds();
    await driveRequest(accessToken, `/files/${file_id}/permissions/${permission_id}`, "DELETE");
    return { content: [{ type: "text", text: `Permission ${permission_id} removed from ${file_id}.` }] };
  });

  server.tool("batch_share_drive_file", "Share a Drive file with multiple users at once.", {
    file_id: z.string(),
    recipients: z.array(z.object({ email: z.string(), role: z.enum(["reader", "commenter", "writer"]) })),
    send_notification: z.boolean().optional().default(false),
  }, async ({ file_id, recipients, send_notification = false }) => {
    const { accessToken } = await getCreds();
    const results: string[] = [];
    for (const r of recipients) {
      try {
        await driveRequest(accessToken, `/files/${file_id}/permissions?sendNotificationEmail=${send_notification}`, "POST", { role: r.role, type: "user", emailAddress: r.email });
        results.push(`✓ ${r.email} (${r.role})`);
      } catch (e) { results.push(`✗ ${r.email}: ${e}`); }
    }
    return { content: [{ type: "text", text: `Batch share results:\n${results.join("\n")}` }] };
  });
}
