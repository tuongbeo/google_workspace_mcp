/**
 * Google Drive Revision/Version Control MCP Tools — Phase 6
 * Covers: list revisions, get revision content, update revision settings,
 *         delete revisions, restore to revision via export, publish settings
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { driveRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerDriveRevisionsTools(server: McpServer, getCreds: GetCredsFunc) {

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
