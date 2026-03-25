/**
 * Google Docs Advanced MCP Tools — Phase 5
 * Covers: named ranges, footnotes, inline images, document styling,
 *         suggestions (tracked changes), text formatting, pagination settings
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerDocsAdvancedTools(server: McpServer, getCreds: GetCredsFunc) {

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
      const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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
      const doc = await docsRequest(accessToken, document_id, "GET", "?fields=namedRanges,title") as any;
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
      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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
      const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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

      const result = await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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

      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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

  server.tool(
    "update_named_style",
    "Update a named paragraph style (e.g. NORMAL_TEXT, HEADING_1..6, TITLE, SUBTITLE). " +
    "This changes the default appearance for all paragraphs using that style across the document. " +
    "Useful for bulk typography changes without editing each paragraph individually.",
    {
      document_id: z.string().describe("Google Doc ID"),
      named_style_type: z.enum([
        "NORMAL_TEXT", "TITLE", "SUBTITLE",
        "HEADING_1", "HEADING_2", "HEADING_3",
        "HEADING_4", "HEADING_5", "HEADING_6",
      ]).describe("The named style to update"),
      font_family: z.string().optional().describe("Font family name, e.g. 'Arial', 'Georgia', 'Roboto'"),
      font_size_pt: z.number().optional().describe("Font size in points"),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      color_hex: z.string().optional().describe("Text color hex, e.g. '#333333'"),
      space_above_pt: z.number().optional().describe("Space above paragraph in points"),
      space_below_pt: z.number().optional().describe("Space below paragraph in points"),
      line_spacing: z.number().optional().describe("Line spacing multiplier, e.g. 1.5 for 150%"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({
      document_id, named_style_type,
      font_family, font_size_pt, bold, italic, color_hex,
      space_above_pt, space_below_pt, line_spacing,
    }) => {
      const { accessToken } = await getCreds();

      function hexToRgb(hex: string) {
        return {
          red: parseInt(hex.slice(1, 3), 16) / 255,
          green: parseInt(hex.slice(3, 5), 16) / 255,
          blue: parseInt(hex.slice(5, 7), 16) / 255,
        };
      }

      const textStyle: Record<string, unknown> = {};
      const textFields: string[] = [];
      const paraStyle: Record<string, unknown> = {};
      const paraFields: string[] = [];

      if (font_family) { textStyle.weightedFontFamily = { fontFamily: font_family }; textFields.push("weightedFontFamily"); }
      if (font_size_pt !== undefined) { textStyle.fontSize = { magnitude: font_size_pt, unit: "PT" }; textFields.push("fontSize"); }
      if (bold !== undefined) { textStyle.bold = bold; textFields.push("bold"); }
      if (italic !== undefined) { textStyle.italic = italic; textFields.push("italic"); }
      if (color_hex) { textStyle.foregroundColor = { color: { rgbColor: hexToRgb(color_hex) } }; textFields.push("foregroundColor"); }
      if (space_above_pt !== undefined) { paraStyle.spaceAbove = { magnitude: space_above_pt, unit: "PT" }; paraFields.push("spaceAbove"); }
      if (space_below_pt !== undefined) { paraStyle.spaceBelow = { magnitude: space_below_pt, unit: "PT" }; paraFields.push("spaceBelow"); }
      if (line_spacing !== undefined) { paraStyle.lineSpacing = line_spacing * 100; paraFields.push("lineSpacing"); }

      const requests: any[] = [];

      // Use updateNamedStyle for both text + para
      if (textFields.length || paraFields.length) {
        const namedStyle: Record<string, unknown> = { namedStyleType: named_style_type };
        if (textFields.length) namedStyle.textStyle = textStyle;
        if (paraFields.length) namedStyle.paragraphStyle = paraStyle;
        const allFields = [...textFields.map(f => `textStyle.${f}`), ...paraFields.map(f => `paragraphStyle.${f}`)];
        requests.push({
          updateNamedStyle: {
            namedStyle,
            fields: allFields.join(","),
          },
        });
      }

      if (!requests.length) {
        return { content: [{ type: "text", text: "No style changes specified." }] };
      }

      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", { requests });

      const changed = [...textFields, ...paraFields];
      return {
        content: [{
          type: "text",
          text: `Named style "${named_style_type}" updated.\nFields: ${changed.join(", ")}`,
        }],
      };
    })
  );

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
      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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
      await docsRequest(accessToken, document_id, "POST", ":batchUpdate", {
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
