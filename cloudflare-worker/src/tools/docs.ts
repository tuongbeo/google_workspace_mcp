/**
 * Google Docs MCP Tools
 * Consolidated from: docs.ts, docs-advanced.ts, docs-phase2.ts, write-google-doc.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { parseMarkdown } from "../docs-engine/parser";
import { buildExecutionPlan } from "../docs-engine/builder";
import { executePass1, executePass2, executePass3, applyHeaderFooter } from "../docs-engine/executor";
import type { GetCredsFunc } from "../types";

// ── Module-level helpers (pure functions, fully testable) ─────────────────────

/** Extract readable text lines from a Doc body content array. */
function extractDocText(bodyContent: any[]): string[] {
  const lines: string[] = [];
  for (const elem of bodyContent || []) {
    if (!elem.paragraph) continue;
    const style = elem.paragraph.paragraphStyle?.namedStyleType || "";
    const text = (elem.paragraph.elements || [])
      .map((e: any) => {
        if (e.textRun) return e.textRun.content || "";
        if (e.person) return `@${e.person.personProperties?.name || e.person.personProperties?.email || "mention"}`;
        return "";
      })
      .join("")
      .trimEnd();
    if (!text.trim()) continue;
    if (style === "HEADING_1") lines.push(`# ${text}`);
    else if (style === "HEADING_2") lines.push(`## ${text}`);
    else if (style === "HEADING_3") lines.push(`### ${text}`);
    else lines.push(text);
  }
  return lines;
}

/** Walk a tab tree and collect text content into a lines array. */
function walkDocTabs(tabList: any[], lines: string[]): void {
  for (const tab of tabList) {
    const p = tab.tabProperties;
    lines.push(`\n## [Tab] ${p?.iconEmoji ? p.iconEmoji + " " : ""}${p?.title || "(Untitled)"} (${p?.tabId})`);
    lines.push(...extractDocText(tab.documentTab?.body?.content));
    if (tab.childTabs?.length) walkDocTabs(tab.childTabs, lines);
  }
}

/** Find a tab by ID in a nested tab tree. Returns null if not found. */
function findDocTab(tabList: any[], id: string): any | null {
  for (const tab of tabList) {
    if (tab.tabProperties?.tabId === id) return tab;
    if (tab.childTabs?.length) {
      const found = findDocTab(tab.childTabs, id);
      if (found) return found;
    }
  }
  return null;
}

function _registerDocsCoreTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("get_google_doc", "Get the content of a Google Doc as text. Supports multi-tab documents.", {
    document_id: z.string(),
    tab_id: z.string().optional().describe("Read a specific tab by ID (use get_doc_tabs to find IDs). If omitted, reads the default/body content."),
    include_all_tabs: z.boolean().optional().default(false).describe("If true, concatenates content from all tabs"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ document_id, tab_id, include_all_tabs = false }) => {
    const { accessToken } = await getCreds();
    const needsTabs = !!(tab_id || include_all_tabs);
    const path = needsTabs ? "?includeTabsContent=true" : "";
    const doc = await docsRequest(accessToken, document_id, path) as any;

    const lines: string[] = [`# ${doc.title}`, ""];

    if (include_all_tabs && doc.tabs?.length) {
      walkDocTabs(doc.tabs, lines);
    } else if (tab_id && doc.tabs?.length) {
      const tab = findDocTab(doc.tabs, tab_id);
      if (!tab) return { content: [{ type: "text", text: `Tab "${tab_id}" not found. Use get_doc_tabs to list available tabs.` }] };
      const p = tab.tabProperties;
      lines.push(`[Tab: ${p?.iconEmoji ? p.iconEmoji + " " : ""}${p?.title || "(Untitled)"}]`, "");
      lines.push(...extractDocText(tab.documentTab?.body?.content));
    } else {
      lines.push(...extractDocText(doc.body?.content));
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));



  server.tool("modify_doc_text", "Replace text in a Google Doc (find and replace).", {
    document_id: z.string(),
    old_text: z.string().describe("Text to find and replace"),
    new_text: z.string().describe("Replacement text"),
    match_case: z.boolean().optional().default(false),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, old_text, new_text, match_case = false }) => {
    const { accessToken } = await getCreds();
    const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
      requests: [{
        replaceAllText: {
          containsText: { text: old_text, matchCase: match_case },
          replaceText: new_text,
        }
      }]
    }) as any;
    const count = result.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
    return { content: [{ type: "text", text: `Replaced ${count} occurrence(s) of "${old_text}" → "${new_text}"` }] };
  }));

  server.tool("find_and_replace_doc", "Find and replace text across a Google Doc.", {
    document_id: z.string(),
    replacements: z.array(z.object({ find: z.string(), replace: z.string(), match_case: z.boolean().optional() })).describe("List of find/replace pairs"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, replacements }) => {
    const { accessToken } = await getCreds();
    const requests = replacements.map(r => ({
      replaceAllText: { containsText: { text: r.find, matchCase: r.match_case || false }, replaceText: r.replace }
    }));
    const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests }) as any;
    const counts = (result.replies || []).map((r: any, i: number) =>
      `"${replacements[i].find}" → "${replacements[i].replace}": ${r.replaceAllText?.occurrencesChanged || 0} occurrence(s)`
    );
    return { content: [{ type: "text", text: `Find and replace results:\n${counts.join("\n")}` }] };
  }));

  server.tool("insert_doc_elements", "Insert elements into a Google Doc (table, page break, horizontal rule).", {
    document_id: z.string(),
    element_type: z.enum(["table", "page_break", "horizontal_rule"]),
    index: z.number().optional().default(1).describe("Insertion index in the doc body"),
    table_rows: z.number().optional().default(3).describe("Rows for table"),
    table_columns: z.number().optional().default(3).describe("Columns for table"),
  }, withErrorHandler(async ({ document_id, element_type, index = 1, table_rows = 3, table_columns = 3 }) => {
    const { accessToken } = await getCreds();
    let request: Record<string, unknown>;
    if (element_type === "table") {
      request = { insertTable: { location: { index }, rows: table_rows, columns: table_columns } };
    } else if (element_type === "page_break") {
      request = { insertPageBreak: { location: { index } } };
    } else {
      request = { insertText: { location: { index }, text: "\n---\n" } };
    }
    await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests: [request] });
    return { content: [{ type: "text", text: `${element_type} inserted at index ${index}.` }] };
  }));


  server.tool("batch_update_doc", "Execute multiple raw batchUpdate requests on a Google Doc.", {
    document_id: z.string(),
    requests: z.array(z.record(z.any())).describe("Array of Google Docs API batchUpdate request objects"),
    tab_id: z.string().optional().describe("Tab ID for multi-tab docs — injects tabsCriteria into the request"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, requests, tab_id }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { requests };
    if (tab_id) body.tabsCriteria = { tabIds: [tab_id] };
    const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", body) as any;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations executed.` }] };
  }));

  server.tool("export_doc_to_pdf", "Export a Google Doc to PDF (returns download URL).", {
    document_id: z.string(),
  }, withErrorHandler(async ({ document_id }) => {
    const { accessToken } = await getCreds();
    await docsRequest(accessToken, document_id) as any;
    const exportUrl = `https://docs.google.com/document/d/${document_id}/export?format=pdf`;
    const resp = await fetch(exportUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    const sizeKb = Math.round(bytes.byteLength / 1024);
    return { content: [{ type: "text", text: `PDF export ready. Size: ${sizeKb} KB\nDirect download: ${exportUrl}\n(Note: requires authentication — add ?access_token=... or use Drive export API)` }] };
  }));

  server.tool("inspect_doc_structure", "Inspect the structural elements of a Google Doc (indices, types). Supports tab_id for multi-tab documents — each tab has its own independent index space starting at 1.", {
    document_id: z.string(),
    tab_id: z.string().optional().describe("Tab ID to inspect. If omitted, inspects the default body. Get tab IDs from get_doc_tabs."),
  }, withErrorHandler(async ({ document_id, tab_id }) => {
    const { accessToken } = await getCreds();
    const path = tab_id ? "?includeTabsContent=true" : "";
    const doc = await docsRequest(accessToken, document_id, path) as any;

    let bodyContent: any[];
    let contextLabel: string;

    if (tab_id) {
      const tab = findDocTab(doc.tabs || [], tab_id);
      if (!tab) return { content: [{ type: "text", text: `Tab "${tab_id}" not found. Use get_doc_tabs to list tabs.` }] };
      bodyContent = tab.documentTab?.body?.content || [];
      contextLabel = `Tab: ${tab.tabProperties?.title ?? tab_id} (index space is independent, starts at 1)`;
    } else {
      bodyContent = doc.body?.content || [];
      contextLabel = "Default body";
    }

    const lines = [`Doc: ${doc.title}`, `Context: ${contextLabel}`, ""];
    let i = 0;
    for (const elem of bodyContent.slice(0, 30)) {
      if (elem.paragraph) {
        const style = elem.paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
        const text = (elem.paragraph.elements || []).map((e: any) => e.textRun?.content || "").join("").substring(0, 60).replace(/\n/g, "↵");
        lines.push(`[${i}] Paragraph [${elem.startIndex}-${elem.endIndex}] ${style}: "${text}"`);
      } else if (elem.table) {
        lines.push(`[${i}] Table [${elem.startIndex}-${elem.endIndex}] ${elem.table.rows}×${elem.table.columns}`);
      } else if (elem.tableOfContents) {
        lines.push(`[${i}] TableOfContents [${elem.startIndex}-${elem.endIndex}]`);
      } else if (elem.sectionBreak) {
        lines.push(`[${i}] SectionBreak [${elem.startIndex}-${elem.endIndex}]`);
      }
      i++;
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("list_document_comments", "List comments on a Google Doc.", {
    document_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments?fields=comments(id,author,content,createdTime,resolved,replies)&pageSize=100`, accessToken) as any;
    const comments = data.comments || [];
    if (!comments.length) return { content: [{ type: "text", text: "No comments." }] };
    const lines = comments.map((c: any) =>
      `ID: ${c.id}\nAuthor: ${c.author?.displayName}\nContent: ${c.content}\nCreated: ${c.createdTime}\nResolved: ${c.resolved || false}\nReplies: ${c.replies?.length || 0}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
  }));

  server.tool("add_document_comment", "Add a comment to a Google Doc.", {
    document_id: z.string(),
    content: z.string().describe("Comment text"),
  }, withErrorHandler(async ({ document_id, content }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments`, accessToken, "POST", { content }) as any;
    return { content: [{ type: "text", text: `Comment added. ID: ${result.id}` }] };
  }));

  server.tool("reply_to_document_comment", "Reply to an existing comment on a Google Doc.", {
    document_id: z.string(),
    comment_id: z.string(),
    reply_content: z.string(),
    resolve: z.boolean().optional().default(false),
  }, withErrorHandler(async ({ document_id, comment_id, reply_content, resolve = false }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { content: reply_content };
    if (resolve) body.action = "resolve";
    const result = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments/${comment_id}/replies`, accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Reply added. Reply ID: ${result.id}${resolve ? " | Comment resolved." : ""}` }] };
  }));
}

// ─── Additional tools to match upstream ──────────────────────────────────────

function _registerDocsExtraTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("search_docs", "Search Google Docs by name in Drive.", {
    query: z.string().describe("Text to search in document names"),
    max_results: z.number().optional().default(10),
    folder_id: z.string().optional().describe("Limit search to a specific folder"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, max_results = 10, folder_id }) => {
    const { accessToken } = await getCreds();
    let q = `mimeType='application/vnd.google-apps.document' and name contains '${query.replace(/'/g, "\\'")}' and trashed=false`;
    if (folder_id) q += ` and '${folder_id}' in parents`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: `No docs found for: "${query}"` }] };
    const lines = files.map((f: any) => `📄 ${f.name}\n   ID: ${f.id}\n   Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink}`);
    return { content: [{ type: "text", text: `Found ${files.length} docs:\n\n${lines.join("\n\n")}` }] };
  }));

  server.tool("list_docs_in_folder", "List Google Docs in a specific Drive folder.", {
    folder_id: z.string().describe("Drive folder ID"),
    max_results: z.number().optional().default(20),
  }, withErrorHandler(async ({ folder_id, max_results = 20 }) => {
    const { accessToken } = await getCreds();
    const q = `mimeType='application/vnd.google-apps.document' and '${folder_id}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No docs in this folder." }] };
    const lines = files.map((f: any) => `📄 ${f.name} | ID: ${f.id} | ${f.modifiedTime}`);
    return { content: [{ type: "text", text: `Docs in folder (${files.length}):\n${lines.join("\n")}` }] };
  }));

  server.tool("update_doc_headers_footers", "Update the header or footer of a Google Doc.", {
    document_id: z.string(),
    text: z.string().describe("New text content for the header/footer"),
    target: z.enum(["header", "footer"]).default("header"),
    section_type: z.enum(["DEFAULT", "FIRST_PAGE", "EVEN_PAGE"]).optional().default("DEFAULT"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, text, target = "header", section_type = "DEFAULT" }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const headerId = target === "header" ? doc.documentStyle?.defaultHeaderId : doc.documentStyle?.defaultFooterId;
    if (!headerId) {
      const createReq: Record<string, unknown> = target === "header"
        ? { createHeader: { type: section_type } }
        : { createFooter: { type: section_type } };
      const createResult = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests: [createReq] }) as any;
      const newId = target === "header"
        ? createResult.replies?.[0]?.createHeader?.headerId
        : createResult.replies?.[0]?.createFooter?.footerId;
      if (newId) {
        await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
          requests: [{ insertText: { location: { segmentId: newId, index: 0 }, text } }]
        });
        return { content: [{ type: "text", text: `${target} created and set to: "${text}"` }] };
      }
      return { content: [{ type: "text", text: `Could not create ${target}.` }] };
    }
    const headerDoc = await docsRequest(accessToken, `${document_id}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`) as any;
    const segment = target === "header" ? headerDoc.headers?.[headerId] : headerDoc.footers?.[headerId];
    const endIndex = segment?.content?.slice(-1)[0]?.endIndex ?? 1;
    const requests: any[] = [];
    if (endIndex > 1) requests.push({ deleteContentRange: { range: { segmentId: headerId, startIndex: 0, endIndex: endIndex - 1 } } });
    requests.push({ insertText: { location: { segmentId: headerId, index: 0 }, text } });
    await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests });
    return { content: [{ type: "text", text: `${target} updated to: "${text}"` }] };
  }));

  server.tool("create_table_with_data", "Create a table populated with data in a Google Doc.", {
    document_id: z.string(),
    data: z.array(z.array(z.string())).describe("2D array — first row is headers, subsequent rows are data"),
    insertion_index: z.number().optional().default(1).describe("Index where table is inserted"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, data, insertion_index = 1 }) => {
    const { accessToken } = await getCreds();
    if (!data.length || !data[0].length) return { content: [{ type: "text", text: "No data provided." }] };
    const rows = data.length;
    const cols = data[0].length;
    await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
      requests: [{ insertTable: { rows, columns: cols, location: { index: insertion_index } } }]
    }) as any;
    const doc = await docsRequest(accessToken, document_id) as any;
    const tableElem = doc.body?.content?.find((e: any) => e.table && e.table.rows === rows && e.table.columns === cols);
    if (!tableElem) return { content: [{ type: "text", text: `Table created (${rows}×${cols}) but could not fill cells — do it manually via batch_update_doc.` }] };
    const insertRequests: any[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = tableElem.table.tableRows[r]?.tableCells[c];
        const cellIndex = cell?.content?.[0]?.startIndex;
        if (cellIndex !== undefined && data[r][c]) {
          insertRequests.push({ insertText: { location: { index: cellIndex }, text: data[r][c] } });
        }
      }
    }
    if (insertRequests.length) {
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests: insertRequests });
    }
    return { content: [{ type: "text", text: `Table ${rows}×${cols} created and filled with ${insertRequests.length} cells.` }] };
  }));




  server.tool("update_doc_tab", "Update properties of a Google Doc tab (title and/or emoji icon).", {
    document_id: z.string(),
    tab_id: z.string().describe("Tab ID to update"),
    title: z.string().optional().describe("New title for the tab"),
    icon_emoji: z.string().optional().describe("New emoji icon (e.g. '🎯'). Pass empty string to clear."),
  }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, tab_id, title, icon_emoji }) => {
    const { accessToken } = await getCreds();
    const tabProperties: Record<string, unknown> = { tabId: tab_id };
    const fields: string[] = [];
    if (title !== undefined) { tabProperties.title = title; fields.push("title"); }
    if (icon_emoji !== undefined) { tabProperties.iconEmoji = icon_emoji; fields.push("iconEmoji"); }
    if (!fields.length) return { content: [{ type: "text", text: "Nothing to update — provide title and/or icon_emoji." }] };
    await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
      requests: [{ updateDocumentTabProperties: { tabProperties, fields: fields.join(",") } }]
    });
    const updated = fields.map(f => f === "title" ? `title → "${title}"` : `emoji → "${icon_emoji}"`).join(", ");
    return { content: [{ type: "text", text: `Tab ${tab_id} updated: ${updated}` }] };
  }));

  server.tool("get_doc_tabs", "List all tabs in a Google Doc with their hierarchy, IDs, titles, and emoji icons.", {
    document_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id, "?includeTabsContent=false") as any;
    const rootTabs: any[] = doc.tabs || [];

    interface TabInfo {
      tab_id: string; title: string; index: number; nested_level: number;
      parent_tab_id: string | null; icon_emoji: string | null; child_count: number;
    }

    function flattenTabs(tabList: any[], level = 0): TabInfo[] {
      const result: TabInfo[] = [];
      for (const tab of tabList) {
        const p = tab.tabProperties || {};
        result.push({
          tab_id: p.tabId ?? "", title: p.title ?? "(Untitled)", index: p.index ?? 0,
          nested_level: level, parent_tab_id: p.parentTabId ?? null,
          icon_emoji: p.iconEmoji ?? null, child_count: tab.childTabs?.length ?? 0,
        });
        if (tab.childTabs?.length) result.push(...flattenTabs(tab.childTabs, level + 1));
      }
      return result;
    }

    const tabs = flattenTabs(rootTabs);
    if (!tabs.length) {
      return { content: [{ type: "text", text: JSON.stringify({ document_title: doc.title, document_id, tab_count: 0, tabs: [], note: "Document uses default single-tab layout — no named tabs." }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ document_title: doc.title, document_id, tab_count: tabs.length, tabs }, null, 2) }] };
  }));

  server.tool("get_doc_tab_content", "Get the text content of a specific tab in a Google Doc.", {
    document_id: z.string(),
    tab_id: z.string().describe("Tab ID to read (get from get_doc_tabs)"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ document_id, tab_id }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id, "?includeTabsContent=true") as any;

    const tab = findDocTab(doc.tabs || [], tab_id);
    if (!tab) return { content: [{ type: "text", text: `Tab "${tab_id}" not found. Use get_doc_tabs to list available tabs.` }] };

    const p = tab.tabProperties;
    const lines: string[] = [`Tab: ${p?.iconEmoji ? p.iconEmoji + " " : ""}${p?.title || "(Untitled)"}`, `ID: ${tab_id}`, ""];

    for (const elem of tab.documentTab?.body?.content || []) {
      if (!elem.paragraph) continue;
      const style = elem.paragraph.paragraphStyle?.namedStyleType || "";
      const text = (elem.paragraph.elements || [])
        .map((e: any) => {
          if (e.textRun) return e.textRun.content || "";
          if (e.person) return `@${e.person.personProperties?.name || e.person.personProperties?.email || "mention"}`;
          return "";
        })
        .join("").trimEnd();
      if (!text.trim()) continue;
      if (style === "HEADING_1") lines.push(`# ${text}`);
      else if (style === "HEADING_2") lines.push(`## ${text}`);
      else if (style === "HEADING_3") lines.push(`### ${text}`);
      else lines.push(text);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("insert_person_mention",
    "Insert a @mention smart chip into a Google Doc. " +
    "The chip is a real Google smart chip (not plain text) linked to the person's Google profile. " +
    "Optionally wrap the chip with prefix/suffix text in the same operation. " +
    "If no index is provided, the chip is appended at the end of the document body.",
    {
      document_id: z.string(),
      email: z.string().describe("Google account email of the person to mention"),
      name: z.string().optional().describe("Display name for the chip. If omitted, email is displayed."),
      index: z.number().optional().describe("Character index where the chip is inserted. If omitted, the tool auto-detects the safe end of the document body."),
      tab_id: z.string().optional().describe("Tab ID to insert into. Omit for default/single-tab docs."),
      prefix_text: z.string().optional().describe("Text to insert immediately BEFORE the chip."),
      suffix_text: z.string().optional().describe("Text to insert immediately AFTER the chip."),
    }, { readOnlyHint: false }, withErrorHandler(async ({ document_id, email, name, index, tab_id, prefix_text, suffix_text }) => {
      const { accessToken } = await getCreds();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { content: [{ type: "text", text: `Invalid email format: "${email}"` }] };
      }

      let baseIndex = index;
      if (baseIndex === undefined) {
        const path = tab_id ? "?includeTabsContent=true" : "";
        const doc = await docsRequest(accessToken, document_id, path) as any;
        if (tab_id) {
          const tab = findDocTab(doc.tabs || [], tab_id);
          if (!tab) return { content: [{ type: "text", text: `Tab "${tab_id}" not found. Use get_doc_tabs.` }] };
          const tabBody = tab.documentTab?.body?.content || [];
          const lastElem = tabBody[tabBody.length - 1];
          baseIndex = lastElem?.endIndex ? lastElem.endIndex - 1 : 1;
        } else {
          const body = doc.body?.content || [];
          const lastElem = body[body.length - 1];
          baseIndex = lastElem?.endIndex ? lastElem.endIndex - 1 : 1;
        }
      }

      const requests: any[] = [];
      let chipIndex = baseIndex;

      if (prefix_text) {
        const loc: Record<string, unknown> = { index: baseIndex };
        if (tab_id) loc.tabId = tab_id;
        requests.push({ insertText: { location: loc, text: prefix_text } });
        chipIndex = baseIndex + prefix_text.length;
      }

      const chipLoc: Record<string, unknown> = { index: chipIndex };
      if (tab_id) chipLoc.tabId = tab_id;
      // insertPerson does NOT accept name field — email only
      const personProperties: Record<string, unknown> = { email };
      requests.push({ insertPerson: { personProperties, location: chipLoc } });

      if (suffix_text) {
        const suffixLoc: Record<string, unknown> = { index: chipIndex + 1 };
        if (tab_id) suffixLoc.tabId = tab_id;
        requests.push({ insertText: { location: suffixLoc, text: suffix_text } });
      }

      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests });

      const displayLabel = name || email;
      const parts: string[] = [`Smart chip inserted for "${displayLabel}" at index ${chipIndex}.`];
      if (prefix_text) parts.push(`Prefix: "${prefix_text}"`);
      if (suffix_text) parts.push(`Suffix: "${suffix_text}"`);
      if (tab_id) parts.push(`Tab: ${tab_id}`);
      parts.push("Note: Notifications only fire if the person has access to the document.");
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }));

  server.tool("apply_doc_text_style",
    "Apply character-level text formatting (bold, italic, underline, strikethrough, font size, color) to a range in a Google Doc.",
    {
      document_id: z.string(),
      start_index: z.number(),
      end_index: z.number(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      font_size: z.number().optional().describe("Font size in points"),
      foreground_color_hex: z.string().optional().describe("Text color hex, e.g. '#FF0000'"),
      background_color_hex: z.string().optional().describe("Text highlight color hex"),
      tab_id: z.string().optional().describe("Tab ID for multi-tab docs"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, start_index, end_index, bold, italic, underline, strikethrough, font_size, foreground_color_hex, background_color_hex, tab_id }) => {
      const { accessToken } = await getCreds();
      const textStyle: Record<string, unknown> = {};
      const fields: string[] = [];
      if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
      if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
      if (underline !== undefined) { textStyle.underline = underline; fields.push("underline"); }
      if (strikethrough !== undefined) { textStyle.strikethrough = strikethrough; fields.push("strikethrough"); }
      if (font_size !== undefined) { textStyle.fontSize = { magnitude: font_size, unit: "PT" }; fields.push("fontSize"); }
      if (foreground_color_hex) {
        const hex = foreground_color_hex.replace("#", "");
        textStyle.foregroundColor = { color: { rgbColor: { red: parseInt(hex.slice(0,2),16)/255, green: parseInt(hex.slice(2,4),16)/255, blue: parseInt(hex.slice(4,6),16)/255 } } };
        fields.push("foregroundColor");
      }
      if (background_color_hex) {
        const hex = background_color_hex.replace("#", "");
        textStyle.backgroundColor = { color: { rgbColor: { red: parseInt(hex.slice(0,2),16)/255, green: parseInt(hex.slice(2,4),16)/255, blue: parseInt(hex.slice(4,6),16)/255 } } };
        fields.push("backgroundColor");
      }
      if (!fields.length) return { content: [{ type: "text", text: "No formatting options provided." }] };
      const range: Record<string, unknown> = { startIndex: start_index, endIndex: end_index };
      if (tab_id) range.tabId = tab_id;
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ updateTextStyle: { range, textStyle, fields: fields.join(",") } }],
      });
      return { content: [{ type: "text", text: `Text style applied to range ${start_index}-${end_index}: ${fields.join(", ")}` }] };
    })
  );


}


function _registerDocsAdvancedTools(server: McpServer, getCreds: GetCredsFunc) {

  // ── Named Ranges ────────────────────────────────────────────────────────────

  server.tool(
    "create_named_range",
    "Create a named range in a Google Doc. Named ranges let you reference specific content " +
    "by name instead of by index — useful for bookmarks, content anchors, and programmatic editing. " +
    "Returns the named range ID. Use inspect_doc_structure to find valid startIndex/endIndex values.",
    {
      document_id: z.string().describe("Google Doc ID"),
      name: z.string().describe("Name for the range (must be unique in the document)"),
      start_index: z.number().int().describe("Start character index (inclusive, 1-based from inspect_doc_structure)"),
      end_index: z.number().int().describe("End character index (exclusive)"),
      tab_id: z.string().optional().describe("Tab ID for multi-tab docs. Omit for default tab."),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, name, start_index, end_index, tab_id }) => {
      const { accessToken } = await getCreds();
      const range: Record<string, unknown> = {
        startIndex: start_index,
        endIndex: end_index,
      };
      if (tab_id) range.tabId = tab_id;
      const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ createNamedRange: { name, range } }],
      }) as any;
      const namedRangeId = result.replies?.[0]?.createNamedRange?.namedRangeId;
      return {
        content: [{
          type: "text",
          text: [
            `Named range created: "${name}"`,
            `ID: ${namedRangeId}`,
            `Range: [${start_index}, ${end_index})`,
            tab_id ? `Tab: ${tab_id}` : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    })
  );

  server.tool(
    "list_named_ranges",
    "List all named ranges defined in a Google Doc. Returns name, ID, and character range for each. " +
    "Named ranges are useful for finding bookmarks, structured content anchors, or ranges set by other apps.",
    {
      document_id: z.string().describe("Google Doc ID"),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ document_id }) => {
      const { accessToken } = await getCreds();
      const doc = await docsRequest(accessToken, document_id, "?fields=namedRanges,title") as any;
      const namedRanges = doc.namedRanges || {};
      const entries = Object.entries(namedRanges) as [string, any][];
      if (!entries.length) {
        return { content: [{ type: "text", text: `Document "${doc.title}" has no named ranges.` }] };
      }
      const lines = [`Named ranges in "${doc.title}" (${entries.length}):`, ""];
      for (const [name, info] of entries) {
        const ranges = info.namedRanges || [];
        for (const nr of ranges) {
          for (const r of nr.ranges || []) {
            lines.push(`- "${name}" (ID: ${nr.namedRangeId})`);
            lines.push(`  Range: [${r.startIndex ?? 0}, ${r.endIndex ?? "?"})`);
            if (r.tabId) lines.push(`  Tab: ${r.tabId}`);
          }
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );

  server.tool(
    "delete_named_range",
    "Delete a named range from a Google Doc by its ID or name. " +
    "Use list_named_ranges to find IDs. Deleting a named range does NOT delete the content — " +
    "it only removes the name tag.",
    {
      document_id: z.string().describe("Google Doc ID"),
      named_range_id: z.string().optional().describe("Named range ID (preferred — use list_named_ranges to find it)"),
      name: z.string().optional().describe("Named range name (deletes ALL ranges with this name)"),
    },
    { readOnlyHint: false, destructiveHint: true },
    withErrorHandler(async ({ document_id, named_range_id, name }) => {
      const { accessToken } = await getCreds();
      if (!named_range_id && !name) {
        return { content: [{ type: "text", text: "Error: provide either named_range_id or name." }] };
      }
      const deleteReq: Record<string, unknown> = {};
      if (named_range_id) deleteReq.namedRangeId = named_range_id;
      else if (name) deleteReq.name = name;
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ deleteNamedRange: deleteReq }],
      });
      const label = named_range_id ? `ID "${named_range_id}"` : `name "${name}"`;
      return { content: [{ type: "text", text: `Named range ${label} deleted.` }] };
    })
  );

  // ── Footnotes ────────────────────────────────────────────────────────────────

  server.tool(
    "insert_footnote",
    "Insert a footnote at a specific index in a Google Doc. The footnote marker appears inline " +
    "at the given index, and footnote content is appended to the document's footnote section. " +
    "After insertion, use batch_update_doc with insertText to add the footnote body text " +
    "(target the footnote segment ID returned by this tool).",
    {
      document_id: z.string().describe("Google Doc ID"),
      index: z.number().int().describe("Character index where the footnote marker is inserted"),
      tab_id: z.string().optional().describe("Tab ID for multi-tab docs"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, index, tab_id }) => {
      const { accessToken } = await getCreds();
      const location: Record<string, unknown> = { index };
      if (tab_id) location.tabId = tab_id;
      const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ createFootnote: { location } }],
      }) as any;
      const footnoteId = result.replies?.[0]?.createFootnote?.footnoteId;
      return {
        content: [{
          type: "text",
          text: [
            `Footnote marker inserted at index ${index}.`,
            `Footnote ID: ${footnoteId}`,
            "",
            "To add footnote body text, call batch_update_doc with:",
            `  { "insertText": { "location": { "segmentId": "${footnoteId}", "index": 1 }, "text": "Your footnote text here." } }`,
          ].join("\n"),
        }],
      };
    })
  );

  // ── Inline Images ────────────────────────────────────────────────────────────

  server.tool(
    "insert_inline_image",
    "Insert an inline image into a Google Doc at a specific index. The image is embedded " +
    "directly in the text flow. Supports images from public URLs or Google Drive file IDs. " +
    "Use inspect_doc_structure to find a valid insertion index.",
    {
      document_id: z.string().describe("Google Doc ID"),
      index: z.number().int().describe("Character index where the image is inserted (from inspect_doc_structure)"),
      image_url: z.string().optional().describe("Public image URL (https://). Use this OR drive_file_id."),
      drive_file_id: z.string().optional().describe("Google Drive file ID of an image. Use this OR image_url."),
      width_pt: z.number().optional().describe("Image width in points (1 inch = 72 pt). Omit to keep original size."),
      height_pt: z.number().optional().describe("Image height in points. Omit to keep original size."),
      tab_id: z.string().optional().describe("Tab ID for multi-tab docs"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, index, image_url, drive_file_id, width_pt, height_pt, tab_id }) => {
      const { accessToken } = await getCreds();
      if (!image_url && !drive_file_id) {
        return { content: [{ type: "text", text: "Error: provide either image_url or drive_file_id." }] };
      }
      const location: Record<string, unknown> = { index };
      if (tab_id) location.tabId = tab_id;

      const req: Record<string, unknown> = { location };
      if (image_url) {
        req.uri = image_url;
      } else if (drive_file_id) {
        req.driveFileId = drive_file_id;
      }
      if (width_pt || height_pt) {
        req.objectSize = {
          width: width_pt ? { magnitude: width_pt, unit: "PT" } : undefined,
          height: height_pt ? { magnitude: height_pt, unit: "PT" } : undefined,
        };
      }

      const result = await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ insertInlineImage: req }],
      }) as any;
      const objectId = result.replies?.[0]?.insertInlineImage?.objectId;
      return {
        content: [{
          type: "text",
          text: [
            `Image inserted at index ${index}.`,
            `Object ID: ${objectId}`,
            width_pt || height_pt ? `Size: ${width_pt ?? "auto"}×${height_pt ?? "auto"} pt` : "Size: original",
          ].join("\n"),
        }],
      };
    })
  );

  // ── Document Page Styling ────────────────────────────────────────────────────

  server.tool(
    "update_document_style",
    "Update document-level page style settings: margins, page size, orientation, " +
    "background color, and pagination mode. All margin/size values are in points (1 inch = 72pt). " +
    "Only provide the fields you want to change — unset fields are left unchanged.",
    {
      document_id: z.string().describe("Google Doc ID"),
      margin_top_pt: z.number().optional().describe("Top margin in points (default ~72pt = 1 inch)"),
      margin_bottom_pt: z.number().optional().describe("Bottom margin in points"),
      margin_left_pt: z.number().optional().describe("Left margin in points"),
      margin_right_pt: z.number().optional().describe("Right margin in points"),
      page_width_pt: z.number().optional().describe("Page width in points. Letter=612, A4=595."),
      page_height_pt: z.number().optional().describe("Page height in points. Letter=792, A4=842."),
      background_color_hex: z.string().optional().describe("Page background color hex, e.g. '#FFFFFF'"),
      use_even_page_header_footer: z.boolean().optional().describe("Use different header/footer for even pages"),
      use_first_page_header_footer: z.boolean().optional().describe("Use different header/footer for first page"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({
      document_id,
      margin_top_pt, margin_bottom_pt, margin_left_pt, margin_right_pt,
      page_width_pt, page_height_pt, background_color_hex,
      use_even_page_header_footer, use_first_page_header_footer,
    }) => {
      const { accessToken } = await getCreds();

      function hexToRgb(hex: string) {
        return {
          red: parseInt(hex.slice(1, 3), 16) / 255,
          green: parseInt(hex.slice(3, 5), 16) / 255,
          blue: parseInt(hex.slice(5, 7), 16) / 255,
        };
      }

      function pt(val: number) {
        return { magnitude: val, unit: "PT" };
      }

      const style: Record<string, unknown> = {};
      const fields: string[] = [];

      if (margin_top_pt !== undefined) { style.marginTop = pt(margin_top_pt); fields.push("marginTop"); }
      if (margin_bottom_pt !== undefined) { style.marginBottom = pt(margin_bottom_pt); fields.push("marginBottom"); }
      if (margin_left_pt !== undefined) { style.marginLeft = pt(margin_left_pt); fields.push("marginLeft"); }
      if (margin_right_pt !== undefined) { style.marginRight = pt(margin_right_pt); fields.push("marginRight"); }
      if (page_width_pt !== undefined) { style.pageSize = { ...(style.pageSize as any || {}), width: pt(page_width_pt) }; fields.push("pageSize"); }
      if (page_height_pt !== undefined) { style.pageSize = { ...(style.pageSize as any || {}), height: pt(page_height_pt) }; fields.push("pageSize"); }
      if (background_color_hex) {
        style.background = { color: { color: { rgbColor: hexToRgb(background_color_hex) } } };
        fields.push("background");
      }
      if (use_even_page_header_footer !== undefined) { style.useEvenPageHeaderFooter = use_even_page_header_footer; fields.push("useEvenPageHeaderFooter"); }
      if (use_first_page_header_footer !== undefined) { style.useFirstPageHeaderFooter = use_first_page_header_footer; fields.push("useFirstPageHeaderFooter"); }

      if (!fields.length) {
        return { content: [{ type: "text", text: "No style changes specified." }] };
      }

      // Deduplicate fields
      const uniqueFields = [...new Set(fields)];

      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ updateDocumentStyle: { documentStyle: style, fields: uniqueFields.join(",") } }],
      });

      return {
        content: [{
          type: "text",
          text: `Document style updated.\nFields changed: ${uniqueFields.join(", ")}`,
        }],
      };
    })
  );

  // ── Default Paragraph Style ──────────────────────────────────────────────────


  // ── Suggestions (Tracked Changes) ───────────────────────────────────────────

  server.tool(
    "get_doc_suggestions",
    "Retrieve all pending suggestions (tracked changes) in a Google Doc. " +
    "Returns each suggestion's ID, author, type, and the suggested text change. " +
    "Use accept_suggestion or reject_suggestion to act on them.",
    {
      document_id: z.string().describe("Google Doc ID"),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ document_id }) => {
      const { accessToken } = await getCreds();
      // Fetch with SUGGESTIONS_INLINE to get suggestion data
      const doc = await docsRequest(
        accessToken,
        document_id,
        "GET",
        "?suggestionsViewMode=SUGGESTIONS_INLINE&includeTabsContent=true&fields=title,suggestionsViewMode,body,tabs"
      ) as any;

      // Collect suggestions from body content
      const suggestions: Record<string, any> = {};

      function scanContent(content: any[]) {
        for (const elem of content || []) {
          // Check paragraph elements for suggestedInsertions / suggestedDeletions
          for (const pe of elem.paragraph?.elements || []) {
            for (const [sugId, sug] of Object.entries(pe.suggestedInsertions || {})) {
              if (!suggestions[sugId]) suggestions[sugId] = { id: sugId, type: "insertion", changes: [] };
              suggestions[sugId].changes.push({ text: pe.textRun?.content, author: (sug as any).suggestionsMetadata });
            }
            for (const [sugId, sug] of Object.entries(pe.suggestedDeletions || {})) {
              if (!suggestions[sugId]) suggestions[sugId] = { id: sugId, type: "deletion", changes: [] };
              suggestions[sugId].changes.push({ text: pe.textRun?.content, author: (sug as any).suggestionsMetadata });
            }
          }
        }
      }

      scanContent(doc.body?.content);
      for (const tab of doc.tabs || []) {
        scanContent(tab.documentTab?.body?.content);
      }

      const list = Object.values(suggestions);
      if (!list.length) {
        return { content: [{ type: "text", text: `No pending suggestions in "${doc.title}".` }] };
      }

      const lines = [`${list.length} suggestion(s) in "${doc.title}":`, ""];
      for (const s of list) {
        lines.push(`ID: ${s.id} | Type: ${s.type}`);
        const textPreview = s.changes.map((c: any) => c.text?.replace(/\n/g, "\\n")).join("").substring(0, 80);
        if (textPreview) lines.push(`  Text: "${textPreview}"`);
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );

  server.tool(
    "accept_suggestion",
    "Accept a specific suggestion (tracked change) in a Google Doc by its suggestion ID. " +
    "Accepting inserts or removes the suggested text permanently. " +
    "Use get_doc_suggestions to find suggestion IDs.",
    {
      document_id: z.string().describe("Google Doc ID"),
      suggestion_id: z.string().describe("Suggestion ID (from get_doc_suggestions)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, suggestion_id }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ acceptSuggestion: { suggestionId: suggestion_id } }],
      });
      return { content: [{ type: "text", text: `Suggestion "${suggestion_id}" accepted.` }] };
    })
  );

  server.tool(
    "reject_suggestion",
    "Reject a specific suggestion (tracked change) in a Google Doc by its suggestion ID. " +
    "Rejecting discards the proposed change and keeps the original text. " +
    "Use get_doc_suggestions to find suggestion IDs.",
    {
      document_id: z.string().describe("Google Doc ID"),
      suggestion_id: z.string().describe("Suggestion ID (from get_doc_suggestions)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, suggestion_id }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{ rejectSuggestion: { suggestionId: suggestion_id } }],
      });
      return { content: [{ type: "text", text: `Suggestion "${suggestion_id}" rejected.` }] };
    })
  );

  // ── Document metadata ───────────────────────────────────────────────────────

  server.tool(
    "get_doc_metadata",
    "Get detailed metadata about a Google Doc: title, revision ID, word count, " +
    "page count estimate, tab count, suggestion count, and document style (margins, page size). " +
    "Useful as a fast document overview without fetching full content.",
    {
      document_id: z.string().describe("Google Doc ID"),
    },
    { readOnlyHint: true },
    withErrorHandler(async ({ document_id }) => {
      const { accessToken } = await getCreds();
      const doc = await googleFetch(
        `https://docs.googleapis.com/v1/documents/${document_id}?fields=title,revisionId,documentStyle,suggestionsViewMode,tabs,body&includeTabsContent=false`,
        accessToken
      ) as any;

      const style = doc.documentStyle || {};
      const pageSize = style.pageSize || {};
      const lines = [
        `Title: ${doc.title}`,
        `Revision ID: ${doc.revisionId || "N/A"}`,
        `Tabs: ${doc.tabs?.length ?? 1}`,
      ];

      if (pageSize.width || pageSize.height) {
        const w = pageSize.width?.magnitude;
        const h = pageSize.height?.magnitude;
        const unit = pageSize.width?.unit || "PT";
        lines.push(`Page size: ${w}×${h} ${unit} (${unit === "PT" ? `${(w/72).toFixed(2)}"×${(h/72).toFixed(2)}"` : ""})`);
      }
      if (style.marginTop) {
        const mt = style.marginTop.magnitude;
        const mb = style.marginBottom?.magnitude;
        const ml = style.marginLeft?.magnitude;
        const mr = style.marginRight?.magnitude;
        lines.push(`Margins (pt): top=${mt} bottom=${mb} left=${ml} right=${mr}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    })
  );
}


function _registerDocsPhase2Tools(server: McpServer, getCreds: GetCredsFunc) {

  // ── manage_table_cells ──────────────────────────────────────────────────────

  server.tool("manage_table_cells",
    "Merge/unmerge table cells, set column widths, or set row min-height in a Google Doc.",
    {
      action:           z.enum(["merge","unmerge","set_column_width","set_row_height"]),
      document_id:      z.string(),
      table_start_index: z.number().int().describe("Character index where the table starts (from inspect_doc_structure)"),
      row_start:        z.number().int().optional().describe("0-based start row (merge/unmerge)"),
      row_end:          z.number().int().optional().describe("0-based end row exclusive (merge/unmerge)"),
      col_start:        z.number().int().optional().describe("0-based start col (merge/unmerge/set_column_width)"),
      col_end:          z.number().int().optional().describe("0-based end col exclusive (merge/unmerge)"),
      width_pt:         z.number().optional().describe("Column width in points (set_column_width)"),
      height_pt:        z.number().optional().describe("Minimum row height in points (set_row_height)"),
      row_index:        z.number().int().optional().describe("0-based row index (set_row_height)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, table_start_index, row_start = 0, row_end = 1, col_start = 0, col_end = 1, width_pt, height_pt, row_index = 0 }) => {
      const { accessToken } = await getCreds();

      const tableCellLoc = {
        tableStartLocation: { index: table_start_index },
        rowIndex: row_start,
        columnIndex: col_start,
      };

      let req: any;
      if (action === "merge") {
        req = {
          mergeTableCells: {
            tableRange: {
              tableCellLocation: tableCellLoc,
              rowSpan: (row_end ?? row_start + 1) - row_start,
              columnSpan: (col_end ?? col_start + 1) - col_start,
            },
          },
        };
      } else if (action === "unmerge") {
        req = {
          unmergeTableCells: {
            tableRange: {
              tableCellLocation: tableCellLoc,
              rowSpan: (row_end ?? row_start + 1) - row_start,
              columnSpan: (col_end ?? col_start + 1) - col_start,
            },
          },
        };
      } else if (action === "set_column_width") {
        if (!width_pt) throw new Error("width_pt required");
        req = {
          updateTableColumnProperties: {
            tableStartLocation: { index: table_start_index },
            columnIndices: [col_start],
            tableColumnProperties: {
              widthType: "FIXED_WIDTH",
              width: { magnitude: width_pt, unit: "PT" },
            },
            fields: "widthType,width",
          },
        };
      } else if (action === "set_row_height") {
        if (!height_pt) throw new Error("height_pt required");
        req = {
          updateTableRowStyle: {
            tableStartLocation: { index: table_start_index },
            rowIndices: [row_index],
            tableRowStyle: { minRowHeight: { magnitude: height_pt, unit: "PT" } },
            fields: "minRowHeight",
          },
        };
      }

      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests: [req] });
      return { content: [{ type: "text", text: `Table cell action "${action}" completed.` }] };
    }),
  );

  // ── insert_section_break ────────────────────────────────────────────────────

  server.tool("insert_section_break",
    "Insert a section break in a Google Doc (page break or continuous).",
    {
      document_id:  z.string(),
      index:        z.number().int().describe("Character index to insert at (from inspect_doc_structure)"),
      section_type: z.enum(["NEXT_PAGE","CONTINUOUS","EVEN_PAGE","ODD_PAGE"]).optional().default("NEXT_PAGE"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, index, section_type = "NEXT_PAGE" }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{
          insertSectionBreak: {
            location: { index },
            sectionType: section_type,
          },
        }],
      });
      return { content: [{ type: "text", text: `Section break (${section_type}) inserted at index ${index}.` }] };
    }),
  );

  // ── delete_paragraph_bullets ────────────────────────────────────────────────

  server.tool("delete_paragraph_bullets",
    "Remove bullet/list formatting from a range of paragraphs in a Google Doc. Preserves the text.",
    {
      document_id: z.string(),
      start_index: z.number().int().describe("Start character index of the range"),
      end_index:   z.number().int().describe("End character index of the range"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, start_index, end_index }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{
          deleteParagraphBullets: {
            range: { startIndex: start_index, endIndex: end_index },
          },
        }],
      });
      return { content: [{ type: "text", text: `Bullets removed from range [${start_index}, ${end_index}).` }] };
    }),
  );

} // end registerDocsPhase2Tools


function _registerWriteGoogleDocTool(server: McpServer, getCreds: GetCredsFunc) {
  server.tool(
    "write_google_doc",
    "Write styled content to Google Doc using markdown. Accepts full markdown with: " +
    "headings (# H1 to ###### H6), **bold**, *italic*, ~~strikethrough~~, " +
    "bullet lists, numbered lists, checklists (- [ ] / - [x]), tables, " +
    "inline `code` and fenced code blocks, > blockquotes, ![images](url), " +
    "@[Name](email) mentions, footnotes ([^1] + [^1]: text), [links](url), " +
    "--- horizontal rules, \\pagebreak, and \\toc (table of contents). " +
    "Creates new doc if no document_id. Appends to existing doc if document_id provided. " +
    "Supports multi-tab documents. Theme and font pair control visual styling.",
    {
      // Content
      content: z.string().describe("Markdown content with extended syntax"),

      // Styling
      theme: z.enum(["corporate", "modern", "warm", "nature", "minimal", "vibrant"])
        .optional().default("corporate")
        .describe("Visual theme for the document"),
      font_pair: z.enum(["open_roboto", "raleway_noto", "merriweather_open", "mulish_nunito"])
        .optional().default("open_roboto")
        .describe("Heading and body font pair"),

      // Create mode
      name: z.string().optional()
        .describe("Document name — required when creating a new doc (no document_id)"),
      parent_folder_id: z.string().optional()
        .describe("Drive folder ID to place the new doc in"),

      // Append mode
      document_id: z.string().optional()
        .describe("Existing doc ID. Provide to append or write to an existing document."),
      tab_id: z.string().optional()
        .describe("Write into a specific tab. Use manage_doc_tabs to list tab IDs."),
      new_tab: z.object({
        title: z.string(),
        emoji: z.string().optional(),
        parent_tab_id: z.string().optional(),
      }).optional()
        .describe("Create a new tab and write content into it"),
      position: z.enum(["append", "replace"]).optional().default("append")
        .describe("append = add after existing content (default). replace = clear then write."),

      // Document options
      header_text: z.string().optional()
        .describe("Text displayed in the page header on every page"),
      footer_text: z.string().optional()
        .describe("Text displayed in the page footer on every page"),
      alignment: z.enum(["left", "justify"]).optional().default("left")
        .describe("Body text alignment. 'justify' for full-width justified text (good for formal documents)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({
      content,
      theme = "corporate",
      font_pair = "open_roboto",
      name,
      parent_folder_id,
      document_id,
      tab_id,
      new_tab,
      position = "append",
      header_text,
      footer_text,
      alignment = "left",
    }) => {
      const { accessToken } = await getCreds();

      // ── Determine mode ─────────────────────────────────────────────────────

      let docId: string;
      let activeTabId: string | undefined = tab_id;
      let docTitle: string;
      let docUrl: string;
      let applyTheme = true;

      if (!document_id) {
        // CREATE MODE
        if (!name) throw new Error("Parameter 'name' is required when creating a new document (no document_id provided).");

        const meta: Record<string, unknown> = { name, mimeType: "application/vnd.google-apps.document" };
        if (parent_folder_id) meta.parents = [parent_folder_id];

        const driveFile = await googleFetch(
          "https://www.googleapis.com/drive/v3/files",
          accessToken, "POST", meta
        ) as any;
        docId = driveFile.id;
        docTitle = name;
        docUrl = `https://docs.google.com/document/d/${docId}/edit`;

      } else {
        // APPEND / REPLACE MODE
        docId = document_id;

        // Handle new_tab creation
        if (new_tab) {
          const tabProps: Record<string, unknown> = { title: new_tab.title };
          if (new_tab.emoji) tabProps.iconEmoji = new_tab.emoji;
          if (new_tab.parent_tab_id) tabProps.parentTabId = new_tab.parent_tab_id;
          const result = await docsRequest(accessToken, docId, ":batchUpdate", "POST", {
            requests: [{ addDocumentTab: { tabProperties: tabProps } }],
          }) as any;
          activeTabId = result.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
        }

        // Handle replace mode: clear content
        if (position === "replace") {
          const path = activeTabId ? "?includeTabsContent=true" : "";
          const doc = await docsRequest(accessToken, docId, path) as any;
          let bodyContent: any[];
          if (activeTabId && doc.tabs) {
            bodyContent = findTab(doc.tabs, activeTabId)?.documentTab?.body?.content ?? [];
          } else {
            bodyContent = doc.body?.content ?? [];
          }
          const lastElem = bodyContent.slice(-1)[0];
          const endIndex = lastElem?.endIndex ?? 2;
          if (endIndex > 2) {
            const range = activeTabId
              ? { startIndex: 1, endIndex: endIndex - 1, tabId: activeTabId }
              : { startIndex: 1, endIndex: endIndex - 1 };
            const clearBody: Record<string, unknown> = { requests: [{ deleteContentRange: { range } }] };
            if (activeTabId) clearBody.tabsCriteria = { tabIds: [activeTabId] };
            await docsRequest(accessToken, docId, ":batchUpdate", "POST", clearBody);
          }
        }

        // Get current doc info
        const docInfo = await docsRequest(accessToken, docId) as any;
        docTitle = docInfo.title;
        docUrl = `https://docs.google.com/document/d/${docId}/edit`;

        // If no explicit theme, detect from existing doc styles (don't override)
        if (!theme || position === "append") {
          applyTheme = !!theme; // only apply if explicitly passed
        }

        // Get start index for append
        if (position === "append") {
          const path2 = activeTabId ? "?includeTabsContent=true" : "";
          const doc2 = await docsRequest(accessToken, docId, path2) as any;
          let bodyContent2: any[];
          if (activeTabId && doc2.tabs) {
            bodyContent2 = findTab(doc2.tabs, activeTabId)?.documentTab?.body?.content ?? [];
          } else {
            bodyContent2 = doc2.body?.content ?? [];
          }
          // startIndex will be end of current content
        }
      }

      // ── Parse + build plan ────────────────────────────────────────────────

      const ast = parseMarkdown(content);
      const plan = buildExecutionPlan(ast, {
        theme,
        fontPair: font_pair,
        startIndex: 1,
        tabId: activeTabId,
        alignment,
      });

      // ── Execute Pass 1: Text + structure ──────────────────────────────────

      if (plan.pass1Requests.length > 0) {
        await executePass1(accessToken, docId, plan, activeTabId);
      }

      // ── Execute Pass 2: Rich elements ─────────────────────────────────────

      const { warnings } = await executePass2(accessToken, docId, plan.richElements, activeTabId);

      // ── Execute Pass 3: Theme ─────────────────────────────────────────────

      if (applyTheme && plan.themeRequests.length > 0) {
        await executePass3(accessToken, docId, plan);
      }

      // ── Header / Footer ───────────────────────────────────────────────────

      if (header_text || footer_text) {
        await applyHeaderFooter(accessToken, docId, header_text, footer_text);
      }

      // ── Response ──────────────────────────────────────────────────────────

      const parts: string[] = [
        `✅ Google Doc ${document_id ? "updated" : "created"}: "${docTitle}"`,
        `ID: ${docId}`,
        `URL: ${docUrl}`,
        `Theme: ${theme} | Font: ${font_pair}`,
        `Sections: ${plan.stats.sections} | Tables: ${plan.stats.tables} | Images: ${plan.stats.images}`,
        plan.stats.mentions > 0 ? `Mentions: ${plan.stats.mentions}` : "",
        plan.stats.footnotes > 0 ? `Footnotes: ${plan.stats.footnotes}` : "",
        plan.stats.hasToc ? "TOC: inserted" : "",
        activeTabId ? `Tab: ${activeTabId}${new_tab ? ` (new: "${new_tab.title}")` : ""}` : "",
        warnings.length > 0 ? `\n⚠️ Warnings:\n${warnings.map(w => `  • ${w}`).join("\n")}` : "",
      ];

      return {
        content: [{ type: "text", text: parts.filter(Boolean).join("\n") }],
      };
    })
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

function findTab(tabList: any[], tabId: string): any | null {
  for (const tab of tabList ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const found = findTab(tab.childTabs ?? [], tabId);
    if (found) return found;
  }
  return null;
}


function _registerDocsConsolidatedTools(server: McpServer, getCreds: GetCredsFunc): void {
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
}

// ── Unified entry point ───────────────────────────────────────────────────────

export function registerDocsTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerDocsCoreTools(server, getCreds);
  _registerDocsExtraTools(server, getCreds);
  _registerDocsAdvancedTools(server, getCreds);
  _registerDocsPhase2Tools(server, getCreds);
  _registerWriteGoogleDocTool(server, getCreds);
  _registerDocsConsolidatedTools(server, getCreds);
}
