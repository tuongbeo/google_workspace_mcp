/**
 * Google Docs MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerDocsTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("get_google_doc", "Get the content of a Google Doc as text.", {
    document_id: z.string(),
  }, async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const lines: string[] = [`# ${doc.title}`, ""];
    for (const elem of doc.body?.content || []) {
      if (!elem.paragraph) continue;
      const style = elem.paragraph.paragraphStyle?.namedStyleType || "";
      const text = (elem.paragraph.elements || []).map((e: any) => e.textRun?.content || "").join("").trimEnd();
      if (!text.trim()) continue;
      if (style.startsWith("HEADING_1")) lines.push(`# ${text}`);
      else if (style.startsWith("HEADING_2")) lines.push(`## ${text}`);
      else if (style.startsWith("HEADING_3")) lines.push(`### ${text}`);
      else lines.push(text);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("create_google_doc", "Create a new Google Doc.", {
    title: z.string(),
    content: z.string().optional(),
  }, async ({ title, content }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, "", "POST", "", { title }) as any;
    if (content) {
      await docsRequest(accessToken, doc.documentId, "POST", ":batchUpdate", {
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      });
    }
    return { content: [{ type: "text", text: `Doc created: "${doc.title}"\nID: ${doc.documentId}\nURL: https://docs.google.com/document/d/${doc.documentId}/edit` }] };
  });

  server.tool("append_to_google_doc", "Append text to an existing Google Doc.", {
    document_id: z.string(),
    text: z.string(),
  }, async ({ document_id, text }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const content = doc.body?.content || [];
    const lastElem = content[content.length - 1];
    const endIndex = lastElem?.endIndex ? lastElem.endIndex - 1 : 1;
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{ insertText: { location: { index: endIndex }, text: "\n" + text } }],
    });
    return { content: [{ type: "text", text: `Text appended to ${document_id}.` }] };
  });

  server.tool("modify_doc_text", "Replace text in a Google Doc (find and replace).", {
    document_id: z.string(),
    old_text: z.string().describe("Text to find and replace"),
    new_text: z.string().describe("Replacement text"),
    match_case: z.boolean().optional().default(false),
  }, async ({ document_id, old_text, new_text, match_case = false }) => {
    const { accessToken } = await getCreds();
    const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{
        replaceAllText: {
          containsText: { text: old_text, matchCase: match_case },
          replaceText: new_text,
        }
      }]
    }) as any;
    const count = result.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
    return { content: [{ type: "text", text: `Replaced ${count} occurrence(s) of "${old_text}" → "${new_text}"` }] };
  });

  server.tool("find_and_replace_doc", "Find and replace text across a Google Doc.", {
    document_id: z.string(),
    replacements: z.array(z.object({ find: z.string(), replace: z.string(), match_case: z.boolean().optional() })).describe("List of find/replace pairs"),
  }, async ({ document_id, replacements }) => {
    const { accessToken } = await getCreds();
    const requests = replacements.map(r => ({
      replaceAllText: { containsText: { text: r.find, matchCase: r.match_case || false }, replaceText: r.replace }
    }));
    const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests }) as any;
    const counts = (result.replies || []).map((r: any, i: number) =>
      `"${replacements[i].find}" → "${replacements[i].replace}": ${r.replaceAllText?.occurrencesChanged || 0} occurrence(s)`
    );
    return { content: [{ type: "text", text: `Find and replace results:\n${counts.join("\n")}` }] };
  });

  server.tool("insert_doc_elements", "Insert elements into a Google Doc (table, page break, horizontal rule).", {
    document_id: z.string(),
    element_type: z.enum(["table", "page_break", "horizontal_rule"]),
    index: z.number().optional().default(1).describe("Insertion index in the doc body"),
    table_rows: z.number().optional().default(3).describe("Rows for table"),
    table_columns: z.number().optional().default(3).describe("Columns for table"),
  }, async ({ document_id, element_type, index = 1, table_rows = 3, table_columns = 3 }) => {
    const { accessToken } = await getCreds();
    let request: Record<string, unknown>;
    if (element_type === "table") {
      request = { insertTable: { location: { index }, rows: table_rows, columns: table_columns } };
    } else if (element_type === "page_break") {
      request = { insertPageBreak: { location: { index } } };
    } else {
      request = { insertInlineImage: undefined }; // horizontal rule via paragraph
      request = { insertText: { location: { index }, text: "\n---\n" } };
    }
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests: [request] });
    return { content: [{ type: "text", text: `${element_type} inserted at index ${index}.` }] };
  });

  server.tool("update_paragraph_style", "Update paragraph style (heading, list) in a Google Doc.", {
    document_id: z.string(),
    start_index: z.number(),
    end_index: z.number(),
    style: z.enum(["NORMAL_TEXT", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "TITLE", "SUBTITLE"]).optional(),
    list_type: z.enum(["BULLET", "NUMBERED", "none"]).optional(),
  }, async ({ document_id, start_index, end_index, style, list_type }) => {
    const { accessToken } = await getCreds();
    const requests: any[] = [];
    if (style) {
      requests.push({ updateParagraphStyle: { range: { startIndex: start_index, endIndex: end_index }, paragraphStyle: { namedStyleType: style }, fields: "namedStyleType" } });
    }
    if (list_type === "BULLET" || list_type === "NUMBERED") {
      const presetStyle = list_type === "BULLET" ? "BULLET_DISC_CIRCLE_SQUARE" : "NUMBERED_DECIMAL_ALPHA_ROMAN";
      requests.push({ createParagraphBullets: { range: { startIndex: start_index, endIndex: end_index }, bulletPreset: presetStyle } });
    } else if (list_type === "none") {
      requests.push({ deleteParagraphBullets: { range: { startIndex: start_index, endIndex: end_index } } });
    }
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests });
    return { content: [{ type: "text", text: `Paragraph style updated in range ${start_index}-${end_index}.` }] };
  });

  server.tool("batch_update_doc", "Execute multiple raw batchUpdate requests on a Google Doc.", {
    document_id: z.string(),
    requests: z.array(z.record(z.any())).describe("Array of Google Docs API batchUpdate request objects"),
  }, async ({ document_id, requests }) => {
    const { accessToken } = await getCreds();
    const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests }) as any;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations executed.` }] };
  });

  server.tool("export_doc_to_pdf", "Export a Google Doc to PDF (returns download URL).", {
    document_id: z.string(),
  }, async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const exportUrl = `https://docs.google.com/document/d/${document_id}/export?format=pdf`;
    const resp = await fetch(exportUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    const sizeKb = Math.round(bytes.byteLength / 1024);
    return { content: [{ type: "text", text: `PDF export ready. Size: ${sizeKb} KB\nDirect download: ${exportUrl}\n(Note: requires authentication — add ?access_token=... or use Drive export API)` }] };
  });

  server.tool("inspect_doc_structure", "Inspect the structural elements of a Google Doc (indices, types).", {
    document_id: z.string(),
  }, async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const lines = [`Doc: ${doc.title}`, ""];
    let i = 0;
    for (const elem of (doc.body?.content || []).slice(0, 30)) {
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
  });

  server.tool("list_document_comments", "List comments on a Google Doc.", {
    document_id: z.string(),
  }, async ({ document_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments?fields=comments(id,author,content,createdTime,resolved,replies)&pageSize=100`, accessToken) as any;
    const comments = data.comments || [];
    if (!comments.length) return { content: [{ type: "text", text: "No comments." }] };
    const lines = comments.map((c: any) =>
      `ID: ${c.id}\nAuthor: ${c.author?.displayName}\nContent: ${c.content}\nCreated: ${c.createdTime}\nResolved: ${c.resolved || false}\nReplies: ${c.replies?.length || 0}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
  });

  server.tool("add_document_comment", "Add a comment to a Google Doc.", {
    document_id: z.string(),
    content: z.string().describe("Comment text"),
  }, async ({ document_id, content }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments`, accessToken, "POST", { content }) as any;
    return { content: [{ type: "text", text: `Comment added. ID: ${result.id}` }] };
  });

  server.tool("reply_to_document_comment", "Reply to an existing comment on a Google Doc.", {
    document_id: z.string(),
    comment_id: z.string(),
    reply_content: z.string(),
    resolve: z.boolean().optional().default(false),
  }, async ({ document_id, comment_id, reply_content, resolve = false }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { content: reply_content };
    if (resolve) body.action = "resolve";
    const result = await googleFetch(`https://www.googleapis.com/drive/v3/files/${document_id}/comments/${comment_id}/replies`, accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Reply added. Reply ID: ${result.id}${resolve ? " | Comment resolved." : ""}` }] };
  });
}

// ─── Additional tools to match upstream ──────────────────────────────────────

export function registerDocsExtraTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("search_docs", "Search Google Docs by name in Drive.", {
    query: z.string().describe("Text to search in document names"),
    max_results: z.number().optional().default(10),
    folder_id: z.string().optional().describe("Limit search to a specific folder"),
  }, async ({ query, max_results = 10, folder_id }) => {
    const { accessToken } = await getCreds();
    let q = `mimeType='application/vnd.google-apps.document' and name contains '${query.replace(/'/g, "\\'")}' and trashed=false`;
    if (folder_id) q += ` and '${folder_id}' in parents`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: `No docs found for: "${query}"` }] };
    const lines = files.map((f: any) => `📄 ${f.name}\n   ID: ${f.id}\n   Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink}`);
    return { content: [{ type: "text", text: `Found ${files.length} docs:\n\n${lines.join("\n\n")}` }] };
  });

  server.tool("list_docs_in_folder", "List Google Docs in a specific Drive folder.", {
    folder_id: z.string().describe("Drive folder ID"),
    max_results: z.number().optional().default(20),
  }, async ({ folder_id, max_results = 20 }) => {
    const { accessToken } = await getCreds();
    const q = `mimeType='application/vnd.google-apps.document' and '${folder_id}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No docs in this folder." }] };
    const lines = files.map((f: any) => `📄 ${f.name} | ID: ${f.id} | ${f.modifiedTime}`);
    return { content: [{ type: "text", text: `Docs in folder (${files.length}):\n${lines.join("\n")}` }] };
  });

  server.tool("update_doc_headers_footers", "Update the header or footer of a Google Doc.", {
    document_id: z.string(),
    text: z.string().describe("New text content for the header/footer"),
    target: z.enum(["header", "footer"]).default("header"),
    section_type: z.enum(["DEFAULT", "FIRST_PAGE", "EVEN_PAGE"]).optional().default("DEFAULT"),
  }, async ({ document_id, text, target = "header", section_type = "DEFAULT" }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const sections = doc.documentStyle?.defaultHeaderId ? doc : null;
    const headerId = target === "header" ? doc.documentStyle?.defaultHeaderId : doc.documentStyle?.defaultFooterId;
    if (!headerId) {
      // Create header/footer first via batchUpdate
      const createReq: Record<string, unknown> = target === "header"
        ? { createHeader: { type: section_type } }
        : { createFooter: { type: section_type } };
      const createResult = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests: [createReq] }) as any;
      const newId = target === "header"
        ? createResult.replies?.[0]?.createHeader?.headerId
        : createResult.replies?.[0]?.createFooter?.footerId;
      if (newId) {
        await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
          requests: [{ insertText: { location: { segmentId: newId, index: 0 }, text } }]
        });
        return { content: [{ type: "text", text: `${target} created and set to: "${text}"` }] };
      }
      return { content: [{ type: "text", text: `Could not create ${target}.` }] };
    }
    // Clear existing and insert new text
    const headerDoc = await docsRequest(accessToken, `${document_id}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`) as any;
    const segment = target === "header" ? headerDoc.headers?.[headerId] : headerDoc.footers?.[headerId];
    const endIndex = segment?.content?.slice(-1)[0]?.endIndex ?? 1;
    const requests: any[] = [];
    if (endIndex > 1) requests.push({ deleteContentRange: { range: { segmentId: headerId, startIndex: 0, endIndex: endIndex - 1 } } });
    requests.push({ insertText: { location: { segmentId: headerId, index: 0 }, text } });
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests });
    return { content: [{ type: "text", text: `${target} updated to: "${text}"` }] };
  });

  server.tool("create_table_with_data", "Create a table populated with data in a Google Doc.", {
    document_id: z.string(),
    data: z.array(z.array(z.string())).describe("2D array — first row is headers, subsequent rows are data"),
    insertion_index: z.number().optional().default(1).describe("Index where table is inserted"),
  }, async ({ document_id, data, insertion_index = 1 }) => {
    const { accessToken } = await getCreds();
    if (!data.length || !data[0].length) return { content: [{ type: "text", text: "No data provided." }] };
    const rows = data.length;
    const cols = data[0].length;
    // Insert empty table
    const createResult = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{ insertTable: { rows, columns: cols, location: { index: insertion_index } } }]
    }) as any;
    // Re-fetch doc to get table structure and cell indices
    const doc = await docsRequest(accessToken, document_id) as any;
    // Find the newly inserted table
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
      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests: insertRequests });
    }
    return { content: [{ type: "text", text: `Table ${rows}×${cols} created and filled with ${insertRequests.length} cells.` }] };
  });

  server.tool("debug_table_structure", "Debug: get detailed structure of tables in a Google Doc (indices, rows, cells).", {
    document_id: z.string(),
    max_tables: z.number().optional().default(3),
  }, async ({ document_id, max_tables = 3 }) => {
    const { accessToken } = await getCreds();
    const doc = await docsRequest(accessToken, document_id) as any;
    const tables = (doc.body?.content || []).filter((e: any) => e.table);
    const lines = [`Doc: ${doc.title}`, `Tables found: ${tables.length}`, ""];
    for (const [ti, tableElem] of tables.slice(0, max_tables).entries()) {
      const t = tableElem.table;
      lines.push(`=== Table ${ti + 1} [${tableElem.startIndex}-${tableElem.endIndex}] (${t.rows}r × ${t.columns}c) ===`);
      for (const [ri, row] of (t.tableRows || []).entries()) {
        for (const [ci, cell] of (row.tableCells || []).entries()) {
          const text = (cell.content || []).flatMap((e: any) => e.paragraph?.elements || []).map((e: any) => e.textRun?.content || "").join("").trim().substring(0, 40);
          const contentIndex = cell.content?.[0]?.startIndex;
          lines.push(`  [r${ri}c${ci}] startIndex:${cell.startIndex} contentIndex:${contentIndex} text:"${text}"`);
        }
      }
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("insert_doc_tab", "Insert a new tab in a Google Doc (Docs tabs feature).", {
    document_id: z.string(),
    title: z.string().describe("Tab title"),
    parent_tab_id: z.string().optional().describe("Parent tab ID for nested tabs"),
    insertion_index: z.number().optional().describe("Position (0-based)"),
  }, async ({ document_id, title, parent_tab_id, insertion_index }) => {
    const { accessToken } = await getCreds();
    const tabProperties: Record<string, unknown> = { title };
    const req: Record<string, unknown> = { tabProperties };
    if (parent_tab_id) req.parentTabId = parent_tab_id;
    if (insertion_index !== undefined) req.insertionIndex = insertion_index;
    const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{ insertTab: req }]
    }) as any;
    const newTabId = result.replies?.[0]?.insertTab?.tabId;
    return { content: [{ type: "text", text: `Tab "${title}" created.${newTabId ? ` Tab ID: ${newTabId}` : ""}` }] };
  });

  server.tool("delete_doc_tab", "Delete a tab from a Google Doc.", {
    document_id: z.string(),
    tab_id: z.string().describe("Tab ID to delete"),
  }, async ({ document_id, tab_id }) => {
    const { accessToken } = await getCreds();
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{ deleteTab: { tabId: tab_id } }]
    });
    return { content: [{ type: "text", text: `Tab ${tab_id} deleted.` }] };
  });

  server.tool("update_doc_tab", "Update properties of a Google Doc tab (title, nesting).", {
    document_id: z.string(),
    tab_id: z.string(),
    title: z.string().optional(),
  }, async ({ document_id, tab_id, title }) => {
    const { accessToken } = await getCreds();
    const tabProperties: Record<string, unknown> = {};
    const fields: string[] = [];
    if (title) { tabProperties.title = title; fields.push("title"); }
    await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
      requests: [{ updateTabProperties: { tabId: tab_id, tabProperties, fields: fields.join(",") } }]
    });
    return { content: [{ type: "text", text: `Tab ${tab_id} updated.` }] };
  });
}
