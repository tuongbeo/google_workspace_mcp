/**
 * Phase 3 — Tool Consolidation
 * Gộp CRUD groups thành 8 manage_* tools:
 *   manage_doc_tabs, manage_named_ranges, manage_doc_comments, manage_doc_suggestions,
 *   manage_drive_revisions, manage_script_deployments, manage_script_versions, manage_contact_groups
 * Original individual tools remain functional (backward compat).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";


export function registerConsolidatedTools(server: McpServer, getCreds: GetCredsFunc) {

  // ── manage_doc_tabs ─────────────────────────────────────────────────────────

  server.tool("manage_doc_tabs",
    "List, get content, create, delete, or update tabs in a multi-tab Google Doc. Actions: list | get_content | create | delete | update.",
    {
      action:      z.enum(["list","get_content","create","delete","update"]),
      document_id: z.string(),
      tab_id:      z.string().optional().describe("Tab ID (required for get_content, delete, update)"),
      title:       z.string().optional().describe("Tab title (create/update)"),
      emoji:       z.string().optional().describe("Tab emoji icon (create/update), e.g. '📋'"),
      parent_tab_id: z.string().optional().describe("Parent tab ID for nested tabs (create)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, tab_id, title, emoji, parent_tab_id }) => {
      const { accessToken } = await getCreds();

      if (action === "list") {
        const doc = await docsRequest(accessToken, document_id) as any;
        const tabs = doc.tabs || [];
        if (!tabs.length) return { content: [{ type: "text", text: "No tabs found (single-tab document)." }] };
        const lines = tabs.map((t: any) =>
          `Tab: ${t.documentTab?.properties?.title || "(untitled)"} | ID: ${t.tabProperties?.tabId} | Index: ${t.tabProperties?.index}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (action === "get_content") {
        if (!tab_id) throw new Error("tab_id required");
        const doc = await docsRequest(accessToken, document_id, "GET", `?includeTabsContent=true`) as any;
        const tab = (doc.tabs || []).find((t: any) => t.tabProperties?.tabId === tab_id);
        if (!tab) throw new Error(`Tab ${tab_id} not found`);
        const content = tab.documentTab?.body?.content || [];
        const text = content.map((el: any) =>
          el.paragraph?.elements?.map((e: any) => e.textRun?.content || "").join("") || ""
        ).join("").trim();
        return { content: [{ type: "text", text: text || "(empty tab)" }] };
      }

      if (action === "create") {
        const props: any = {};
        if (title) props.title = title;
        if (emoji) props.iconEmoji = emoji;
        if (parent_tab_id) props.parentTabId = parent_tab_id;
        const res = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ addDocumentTab: { tabProperties: props } }],
        }) as any;
        const newTabId = res.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
        return { content: [{ type: "text", text: `Tab created. ID: ${newTabId}` }] };
      }

      if (action === "delete") {
        if (!tab_id) throw new Error("tab_id required");
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ deleteDocumentTab: { tabId: tab_id } }],
        });
        return { content: [{ type: "text", text: `Tab ${tab_id} deleted.` }] };
      }

      if (action === "update") {
        if (!tab_id) throw new Error("tab_id required");
        const props: any = { tabId: tab_id };
        const fields: string[] = [];
        if (title) { props.title = title; fields.push("title"); }
        if (emoji) { props.iconEmoji = emoji; fields.push("iconEmoji"); }
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ updateDocumentTab: { tabProperties: props, fields: fields.join(",") } }],
        });
        return { content: [{ type: "text", text: `Tab ${tab_id} updated.` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_named_ranges ─────────────────────────────────────────────────────

  server.tool("manage_named_ranges",
    "Create, list, or delete named ranges in a Google Doc. Actions: create | list | delete.",
    {
      action:      z.enum(["create","list","delete"]),
      document_id: z.string(),
      name:        z.string().optional().describe("Range name (create)"),
      start_index: z.number().int().optional(),
      end_index:   z.number().int().optional(),
      named_range_id: z.string().optional().describe("Named range ID (delete)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, name, start_index, end_index, named_range_id }) => {
      const { accessToken } = await getCreds();

      if (action === "list") {
        const doc = await docsRequest(accessToken, document_id) as any;
        const ranges = doc.namedRanges || {};
        const entries = Object.entries(ranges).flatMap(([n, v]: [string, any]) =>
          v.namedRanges.map((r: any) => `"${n}" | ID: ${r.namedRangeId} | [${r.ranges?.[0]?.startIndex}-${r.ranges?.[0]?.endIndex}]`)
        );
        return { content: [{ type: "text", text: entries.length ? entries.join("\n") : "No named ranges." }] };
      }

      if (action === "create") {
        if (!name || start_index === undefined || end_index === undefined) throw new Error("name, start_index, end_index required");
        const res = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ createNamedRange: { name, range: { startIndex: start_index, endIndex: end_index } } }],
        }) as any;
        return { content: [{ type: "text", text: `Named range "${name}" created. ID: ${res.replies?.[0]?.createNamedRange?.namedRangeId}` }] };
      }

      if (action === "delete") {
        if (!named_range_id && !name) throw new Error("named_range_id or name required");
        const req: any = named_range_id ? { namedRangeId: named_range_id } : { name };
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ deleteNamedRange: req }],
        });
        return { content: [{ type: "text", text: `Named range deleted.` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_doc_comments ─────────────────────────────────────────────────────

  server.tool("manage_doc_comments",
    "List, add, or reply to comments in a Google Doc. Actions: list | add | reply.",
    {
      action:      z.enum(["list","add","reply"]),
      document_id: z.string(),
      content:     z.string().optional().describe("Comment text (add/reply)"),
      comment_id:  z.string().optional().describe("Comment ID (reply)"),
      anchor: z.object({
        start_index: z.number().int(),
        end_index:   z.number().int(),
      }).optional().describe("Text anchor for new comment (add)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, content, comment_id, anchor }) => {
      const { accessToken } = await getCreds();
      const base = `https://www.googleapis.com/drive/v3/files/${document_id}/comments`;

      if (action === "list") {
        const data = await googleFetch(`${base}?fields=comments(id,content,author,createdTime,replies)&maxResults=50`, accessToken) as any;
        const comments = data.comments || [];
        if (!comments.length) return { content: [{ type: "text", text: "No comments." }] };
        const lines = comments.map((c: any) =>
          `[${c.id}] ${c.author?.displayName}: ${c.content} (${new Date(c.createdTime).toLocaleDateString()})`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (action === "add") {
        if (!content) throw new Error("content required");
        const body: any = { content };
        if (anchor) body.anchor = `{"r":"head","a":[{"l":"${anchor.start_index},${anchor.end_index}"}]}`;
        const res = await googleFetch(base, accessToken, "POST", body) as any;
        return { content: [{ type: "text", text: `Comment added. ID: ${res.id}` }] };
      }

      if (action === "reply") {
        if (!comment_id || !content) throw new Error("comment_id and content required");
        const res = await googleFetch(`${base}/${comment_id}/replies`, accessToken, "POST", { content }) as any;
        return { content: [{ type: "text", text: `Reply added. ID: ${res.id}` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_doc_suggestions ──────────────────────────────────────────────────

  server.tool("manage_doc_suggestions",
    "List, accept, or reject tracked changes (suggestions) in a Google Doc. Actions: list | accept | reject.",
    {
      action:        z.enum(["list","accept","reject"]),
      document_id:   z.string(),
      suggestion_id: z.string().optional().describe("Suggestion ID (accept/reject)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, suggestion_id }) => {
      const { accessToken } = await getCreds();

      if (action === "list") {
        const doc = await docsRequest(accessToken, document_id) as any;
        const suggestions = doc.suggestionsViewMode === "SUGGESTIONS_INLINE" ? [] : [];
        // Get suggestions via batchUpdate dry-run or via the doc body
        const body = doc.body?.content || [];
        const found: string[] = [];
        for (const el of body) {
          if (el.paragraph?.elements) {
            for (const e of el.paragraph.elements) {
              if (e.textRun?.suggestedInsertionIds?.length || e.textRun?.suggestedDeletionIds?.length) {
                const ids = [...(e.textRun.suggestedInsertionIds || []), ...(e.textRun.suggestedDeletionIds || [])];
                found.push(...ids.map((id: string) => `ID: ${id} | Text: "${e.textRun.content?.trim()}"`));
              }
            }
          }
        }
        return { content: [{ type: "text", text: found.length ? found.join("\n") : "No suggestions found." }] };
      }

      if (action === "accept") {
        if (!suggestion_id) throw new Error("suggestion_id required");
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ acceptAllSuggestionsWithId: { suggestionId: suggestion_id } }],
        });
        return { content: [{ type: "text", text: `Suggestion ${suggestion_id} accepted.` }] };
      }

      if (action === "reject") {
        if (!suggestion_id) throw new Error("suggestion_id required");
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ rejectAllSuggestionsWithId: { suggestionId: suggestion_id } }],
        });
        return { content: [{ type: "text", text: `Suggestion ${suggestion_id} rejected.` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

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

  // ── manage_script_deployments ───────────────────────────────────────────────

  server.tool("manage_script_deployments",
    "Create, list, update, or delete Apps Script deployments. Actions: create | list | update | delete.",
    {
      action:        z.enum(["create","list","update","delete"]),
      script_id:     z.string(),
      deployment_id: z.string().optional().describe("Deployment ID (update/delete)"),
      version_number: z.number().int().optional().describe("Script version to deploy (create/update)"),
      description:   z.string().optional(),
      access_level:  z.enum(["MYSELF","DOMAIN","ANYONE","ANYONE_ANONYMOUS"]).optional().default("MYSELF"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, script_id, deployment_id, version_number, description, access_level = "MYSELF" }) => {
      const { accessToken } = await getCreds();
      const base = `https://script.googleapis.com/v1/projects/${script_id}/deployments`;

      if (action === "list") {
        const data = await googleFetch(base, accessToken) as any;
        const deps = data.deployments || [];
        const lines = deps.map((d: any) => `ID: ${d.deploymentId} | ${d.deploymentConfig?.description || "(no desc)"} | v${d.deploymentConfig?.versionNumber}`);
        return { content: [{ type: "text", text: lines.join("\n") || "No deployments." }] };
      }

      if (action === "create") {
        const body: any = { deploymentConfig: { scriptId: script_id, access: access_level } };
        if (version_number) body.deploymentConfig.versionNumber = version_number;
        if (description) body.deploymentConfig.description = description;
        const res = await googleFetch(base, accessToken, "POST", body) as any;
        return { content: [{ type: "text", text: `Deployment created. ID: ${res.deploymentId}` }] };
      }

      if (action === "update") {
        if (!deployment_id) throw new Error("deployment_id required");
        const body: any = { deploymentConfig: {} };
        if (version_number) body.deploymentConfig.versionNumber = version_number;
        if (description) body.deploymentConfig.description = description;
        if (access_level) body.deploymentConfig.access = access_level;
        const res = await googleFetch(`${base}/${deployment_id}`, accessToken, "PUT", body) as any;
        return { content: [{ type: "text", text: `Deployment ${res.deploymentId} updated.` }] };
      }

      if (action === "delete") {
        if (!deployment_id) throw new Error("deployment_id required");
        await googleFetch(`${base}/${deployment_id}`, accessToken, "DELETE");
        return { content: [{ type: "text", text: `Deployment ${deployment_id} deleted.` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_script_versions ──────────────────────────────────────────────────

  server.tool("manage_script_versions",
    "Create, list, or get versions of an Apps Script project. Actions: create | list | get.",
    {
      action:         z.enum(["create","list","get"]),
      script_id:      z.string(),
      version_number: z.number().int().optional().describe("Version number (get)"),
      description:    z.string().optional().describe("Version description (create)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, script_id, version_number, description }) => {
      const { accessToken } = await getCreds();
      const base = `https://script.googleapis.com/v1/projects/${script_id}/versions`;

      if (action === "list") {
        const data = await googleFetch(base, accessToken) as any;
        const vers = data.versions || [];
        const lines = vers.map((v: any) => `v${v.versionNumber} | ${v.createTime} | ${v.description || ""}`);
        return { content: [{ type: "text", text: lines.join("\n") || "No versions." }] };
      }

      if (action === "create") {
        const body: any = {};
        if (description) body.description = description;
        const res = await googleFetch(base, accessToken, "POST", body) as any;
        return { content: [{ type: "text", text: `Version v${res.versionNumber} created.` }] };
      }

      if (action === "get") {
        if (!version_number) throw new Error("version_number required");
        const v = await googleFetch(`${base}/${version_number}`, accessToken) as any;
        return { content: [{ type: "text", text: `v${v.versionNumber} | ${v.createTime} | ${v.description || ""}` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_contact_groups ───────────────────────────────────────────────────

  server.tool("manage_contact_groups",
    "Create, get, delete, list, or modify members of Google Contact groups (labels). Actions: create | get | delete | list | modify_members.",
    {
      action:          z.enum(["create","get","delete","list","modify_members"]),
      group_resource_name: z.string().optional().describe("contactGroups/... (get/delete/modify_members)"),
      name:            z.string().optional().describe("Group name (create)"),
      max_members:     z.number().int().optional().describe("Max members to return with get"),
      add_member_resource_names:    z.array(z.string()).optional().describe("people/... to add"),
      remove_member_resource_names: z.array(z.string()).optional().describe("people/... to remove"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, group_resource_name, name, max_members = 100, add_member_resource_names, remove_member_resource_names }) => {
      const { accessToken } = await getCreds();
      const base = "https://people.googleapis.com/v1/contactGroups";

      if (action === "list") {
        const data = await googleFetch(`${base}?pageSize=50&groupFields=name,memberCount,groupType`, accessToken) as any;
        const groups = data.contactGroups || [];
        const lines = groups.map((g: any) => `${g.resourceName} | ${g.name} | Members: ${g.memberCount ?? "?"} | Type: ${g.groupType}`);
        return { content: [{ type: "text", text: lines.join("\n") || "No groups." }] };
      }

      if (action === "create") {
        if (!name) throw new Error("name required");
        const res = await googleFetch(base, accessToken, "POST", { contactGroup: { name } }) as any;
        return { content: [{ type: "text", text: `Group created: "${res.name}" | ${res.resourceName}` }] };
      }

      if (action === "get") {
        if (!group_resource_name) throw new Error("group_resource_name required");
        const res = await googleFetch(`${base}/${group_resource_name.replace("contactGroups/","")}?maxMembers=${max_members}`, accessToken) as any;
        const members = (res.memberResourceNames || []).join(", ");
        return { content: [{ type: "text", text: `${res.name} (${res.resourceName})\nMembers (${res.memberCount ?? 0}): ${members || "(none)"}` }] };
      }

      if (action === "delete") {
        if (!group_resource_name) throw new Error("group_resource_name required");
        await googleFetch(`${base}/${group_resource_name.replace("contactGroups/","")}`, accessToken, "DELETE");
        return { content: [{ type: "text", text: `Group ${group_resource_name} deleted.` }] };
      }

      if (action === "modify_members") {
        if (!group_resource_name) throw new Error("group_resource_name required");
        const body: any = {};
        if (add_member_resource_names?.length) body.resourceNamesToAdd = add_member_resource_names;
        if (remove_member_resource_names?.length) body.resourceNamesToRemove = remove_member_resource_names;
        await googleFetch(`${base}/${group_resource_name.replace("contactGroups/","")}/members:modify`, accessToken, "POST", body);
        return { content: [{ type: "text", text: `Members updated. Added: ${add_member_resource_names?.length || 0}, Removed: ${remove_member_resource_names?.length || 0}` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

} // end registerConsolidatedTools
