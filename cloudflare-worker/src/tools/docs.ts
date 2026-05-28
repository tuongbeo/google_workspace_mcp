/**
 * Google Docs MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
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

export function registerDocsTools(server: McpServer, getCreds: GetCredsFunc) {

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

export function registerDocsExtraTools(server: McpServer, getCreds: GetCredsFunc) {
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
