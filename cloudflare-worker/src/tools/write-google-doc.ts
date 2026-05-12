/**
 * tools/write-google-doc.ts
 * write_google_doc — unified tool to create or append styled content to Google Docs
 * Replaces: create_google_doc, append_to_google_doc, create_rich_doc,
 *           import_markdown_as_doc, import_to_google_doc
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { parseMarkdown } from "../docs-engine/parser";
import { buildExecutionPlan } from "../docs-engine/builder";
import { executePass1, executePass2, executePass3, applyHeaderFooter } from "../docs-engine/executor";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerWriteGoogleDocTool(server: McpServer, getCreds: GetCredsFunc) {
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
      font_pair: z.enum(["arial_roboto", "georgia_source", "inter_system", "merriweather_open"])
        .optional().default("arial_roboto")
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
    },
    { readOnlyHint: false },
    withErrorHandler(async ({
      content,
      theme = "corporate",
      font_pair = "arial_roboto",
      name,
      parent_folder_id,
      document_id,
      tab_id,
      new_tab,
      position = "append",
      header_text,
      footer_text,
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
          const result = await docsRequest(accessToken, docId, "POST", ":batchUpdate", {
            requests: [{ addDocumentTab: { tabProperties: tabProps } }],
          }) as any;
          activeTabId = result.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
        }

        // Handle replace mode: clear content
        if (position === "replace") {
          const path = activeTabId ? "?includeTabsContent=true" : "";
          const doc = await docsRequest(accessToken, docId, "GET", path) as any;
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
            await docsRequest(accessToken, docId, "POST", ":batchUpdate", clearBody);
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
          const doc2 = await docsRequest(accessToken, docId, "GET", path2) as any;
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
