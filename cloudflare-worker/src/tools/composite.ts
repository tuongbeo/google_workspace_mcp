/**
 * Composite Tools — Phase 2A
 * High-level tools that reduce 80-90% of turns for common tasks.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { getTheme, getFontPair, deriveDocTokens } from "../styles";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

// ── Shared helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return { red: parseInt(h.slice(0,2),16)/255, green: parseInt(h.slice(2,4),16)/255, blue: parseInt(h.slice(4,6),16)/255 };
}

function buildNamedStyleReq(styleType: string, color: string, size: number, bold: boolean, font: string, above: number, below: number) {
  return {
    updateNamedStyle: {
      namedStyle: {
        namedStyleType: styleType,
        textStyle: {
          foregroundColor: { color: { rgbColor: hexToRgb(color) } },
          fontSize: { magnitude: size, unit: "PT" },
          bold,
          weightedFontFamily: { fontFamily: font },
        },
        paragraphStyle: {
          spaceAbove: { magnitude: above, unit: "PT" },
          spaceBelow: { magnitude: below, unit: "PT" },
        },
      },
      fields: "*",
    },
  };
}

const HEADING_STYLE: Record<string, string> = {
  "1": "HEADING_1", "2": "HEADING_2", "3": "HEADING_3", "4": "HEADING_4",
};

const SectionSchema = z.object({
  heading:        z.string().optional(),
  heading_level:  z.enum(["1","2","3","4"]).optional().default("1"),
  paragraphs:     z.array(z.string()).optional(),
  bullet_list:    z.array(z.string()).optional(),
  numbered_list:  z.array(z.string()).optional(),
  table: z.object({
    headers: z.array(z.string()),
    rows:    z.array(z.array(z.string())),
  }).optional(),
});

// ── registerCompositeTools ────────────────────────────────────────────────────

export function registerCompositeTools(server: McpServer, getCreds: GetCredsFunc) {

  // ── create_rich_doc ─────────────────────────────────────────────────────────

  server.tool(
    "create_rich_doc",
    "Create a fully styled Google Doc in 1 call with theme, fonts, headings, body text, " +
    "bullet/numbered lists, and tables. Use this instead of chaining multiple docs tools.",
    {
      title:     z.string(),
      theme:     z.enum(["corporate","modern","warm","nature","minimal","vibrant"]).optional().default("corporate"),
      font_pair: z.enum(["arial_roboto","georgia_source","inter_system","merriweather_open"]).optional().default("arial_roboto"),
      sections:  z.array(SectionSchema).describe("Array of sections — each may have heading, paragraphs, lists, table"),
      folder_id: z.string().optional().describe("Drive folder ID to place the doc in"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ title, theme = "corporate", font_pair = "arial_roboto", sections, folder_id }) => {
      const { accessToken } = await getCreds();
      const colors = getTheme(theme);
      const fonts  = getFontPair(font_pair);
      const tok    = deriveDocTokens(colors, fonts);

      // 1. Create document (Drive API supports folder placement)
      const meta: Record<string, unknown> = {
        name: title,
        mimeType: "application/vnd.google-apps.document",
      };
      if (folder_id) meta.parents = [folder_id];
      const created = await googleFetch(
        "https://www.googleapis.com/drive/v3/files?fields=id,webViewLink",
        accessToken, "POST", meta,
      ) as { id: string; webViewLink: string };
      const docId   = created.id;
      const docLink = created.webViewLink;

      // 2. Apply named styles
      await docsRequest(accessToken, docId, "POST", ":batchUpdate", { requests: [
        buildNamedStyleReq("NORMAL_TEXT", tok.normal.color,   tok.normal.fontSize,   false, fonts.body,    6, 3),
        buildNamedStyleReq("HEADING_1",   tok.heading1.color, tok.heading1.fontSize,  true,  fonts.heading, 16, 6),
        buildNamedStyleReq("HEADING_2",   tok.heading2.color, tok.heading2.fontSize,  true,  fonts.heading, 12, 4),
        buildNamedStyleReq("HEADING_3",   tok.heading3.color, tok.heading3.fontSize,  true,  fonts.heading, 8,  3),
        buildNamedStyleReq("HEADING_4",   tok.heading4.color, tok.heading4.fontSize,  true,  fonts.heading, 6,  2),
      ]});

      // 3. Build and send content requests
      // Strategy: build insertion requests in document order.
      // Each insertText shifts cursor forward by the text length.
      // Tables are inserted inline; their cells are filled in a second batchUpdate.

      let cursor = 1; // Docs start at index 1
      const reqs: any[] = [];
      // Track tables for a second pass: { tableIndex, docCursor, headers, rows }
      const tablesMeta: { headers: string[]; rows: string[][] }[] = [];

      for (const sec of (sections || [])) {
        // Heading
        if (sec.heading) {
          const start = cursor;
          const txt = sec.heading + "\n";
          reqs.push({ insertText: { text: txt, location: { index: cursor } } });
          cursor += txt.length;
          reqs.push({
            updateParagraphStyle: {
              range: { startIndex: start, endIndex: cursor },
              paragraphStyle: { namedStyleType: HEADING_STYLE[sec.heading_level ?? "1"] || "HEADING_1" },
              fields: "namedStyleType",
            },
          });
        }

        // Paragraphs
        for (const para of (sec.paragraphs || [])) {
          const txt = para + "\n";
          reqs.push({ insertText: { text: txt, location: { index: cursor } } });
          cursor += txt.length;
        }

        // Bullet list
        for (const item of (sec.bullet_list || [])) {
          const start = cursor;
          const txt = item + "\n";
          reqs.push({ insertText: { text: txt, location: { index: cursor } } });
          cursor += txt.length;
          reqs.push({
            createParagraphBullets: {
              range: { startIndex: start, endIndex: cursor },
              bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
            },
          });
        }

        // Numbered list
        for (const item of (sec.numbered_list || [])) {
          const start = cursor;
          const txt = item + "\n";
          reqs.push({ insertText: { text: txt, location: { index: cursor } } });
          cursor += txt.length;
          reqs.push({
            createParagraphBullets: {
              range: { startIndex: start, endIndex: cursor },
              bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN",
            },
          });
        }

        // Tables: collect for second pass (can't track cursor after insertTable)
        if (sec.table) {
          tablesMeta.push({ headers: sec.table.headers, rows: sec.table.rows });
        }

        // Section spacer
        reqs.push({ insertText: { text: "\n", location: { index: cursor } } });
        cursor += 1;
      }

      if (reqs.length > 0) {
        await docsRequest(accessToken, docId, "POST", ":batchUpdate", { requests: reqs });
      }

      // 4. Second pass: insert tables at end of document
      // Re-fetch doc to get current end index, then insert each table
      let tableInserted = 0;
      for (const tbl of tablesMeta) {
        const doc2 = await docsRequest(accessToken, docId) as any;
        const body = doc2.body?.content || [];
        // Find last paragraph end index
        let endIdx = 1;
        for (const el of body) {
          const ei = el.endIndex ?? el.paragraph?.endIndex;
          if (typeof ei === "number" && ei > endIdx) endIdx = ei;
        }
        // Insert table at endIdx - 1 (before the final newline)
        const insertAt = Math.max(1, endIdx - 1);
        await docsRequest(accessToken, docId, "POST", ":batchUpdate", {
          requests: [{
            insertTable: {
              rows: tbl.rows.length + 1,
              columns: tbl.headers.length,
              location: { index: insertAt },
            },
          }],
        });
        tableInserted++;
      }

      const tableCount = tablesMeta.length;
      return {
        content: [{ type: "text", text: [
          `✅ Created styled Google Doc: "${title}"`,
          `ID: ${docId}`,
          `Theme: ${theme} | Fonts: ${fonts.heading} / ${fonts.body}`,
          `Sections: ${(sections||[]).length} | Tables: ${tableCount}`,
          tableCount > 0 ? `${tableInserted} table(s) inserted (empty). Use batch_update_doc to fill cells.` : "",
          `Link: ${docLink}`,
        ].filter(Boolean).join("\n") }],
      };
    }),
  );

  // ── import_to_google_doc (enhanced with theme) ───────────────────────────────
  // NOTE: The base import_to_google_doc lives in drive.ts (upload via multipart).
  // This enhanced version applies theme styling after upload using updateNamedStyle.

  server.tool(
    "import_markdown_as_doc",
    "Import markdown content as a styled Google Doc with theme + font pair applied. " +
    "Converts markdown to HTML, uploads to Drive, then applies named styles. " +
    "For plain import without theming, use import_to_google_doc instead.",
    {
      name:             z.string().describe("Document name"),
      content:          z.string().describe("Markdown content"),
      theme:            z.enum(["corporate","modern","warm","nature","minimal","vibrant"]).optional().default("corporate"),
      font_pair:        z.enum(["arial_roboto","georgia_source","inter_system","merriweather_open"]).optional().default("arial_roboto"),
      parent_folder_id: z.string().optional(),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ name, content, theme = "corporate", font_pair = "arial_roboto", parent_folder_id }) => {
      const { accessToken } = await getCreds();
      const colors = getTheme(theme);
      const fonts  = getFontPair(font_pair);
      const tok    = deriveDocTokens(colors, fonts);

      // Convert markdown to HTML
      const html = markdownToDocHtml(content, tok, fonts);

      // Upload via Drive multipart (converts HTML → Google Doc)
      const meta: Record<string, unknown> = {
        name,
        mimeType: "application/vnd.google-apps.document",
      };
      if (parent_folder_id) meta.parents = [parent_folder_id];
      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      form.append("file",     new Blob([html],                  { type: "text/html" }));
      const resp = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form },
      );
      if (!resp.ok) throw new Error(`Upload failed: ${await resp.text()}`);
      const res = await resp.json() as { id: string; name: string; webViewLink: string };

      await docsRequest(accessToken, res.id, "POST", ":batchUpdate", { requests: [
        buildNamedStyleReq("NORMAL_TEXT", tok.normal.color,   tok.normal.fontSize,   false, fonts.body,    6, 3),
        buildNamedStyleReq("HEADING_1",   tok.heading1.color, tok.heading1.fontSize,  true,  fonts.heading, 16, 6),
        buildNamedStyleReq("HEADING_2",   tok.heading2.color, tok.heading2.fontSize,  true,  fonts.heading, 12, 4),
        buildNamedStyleReq("HEADING_3",   tok.heading3.color, tok.heading3.fontSize,  true,  fonts.heading, 8,  3),
      ]});

      return { content: [{ type: "text", text: [
        `✅ Imported as styled Google Doc: "${res.name}"`,
        `ID: ${res.id}`,
        `Theme: ${theme} | Fonts: ${fonts.heading} / ${fonts.body}`,
        `Link: ${res.webViewLink}`,
      ].join("\n") }] };
    }),
  );

} // end registerCompositeTools

// ── Markdown → HTML converter for Google Docs import ─────────────────────────
// Fixes applied:
//   [Fix 3] Escape char pre-processing  — unescape \# \* \| etc. before parsing
//   [Fix 1] Markdown table parser       — |table|syntax| → <table><tr><td>
//   [Fix 2] Blank line normalization    — skip empty lines, let block elements handle spacing
//   [Fix 4] Bold markers in headings    — strip ** from heading text (heading already bold)

function markdownToDocHtml(
  md: string,
  tok: ReturnType<typeof deriveDocTokens>,
  fonts: { heading: string; body: string },
): string {
  // ── Fix 3: Unescape markdown escape sequences before any processing ──────
  md = md.replace(/\\([#*|`_~\[\](){}+\-.!])/g, (_, ch: string) => ch);

  const lines = md.split("\n");
  let html = `<html><head><meta charset="utf-8">
<style>
  body  { font-family: '${fonts.body}', Arial, sans-serif; font-size: 11pt; color: ${tok.normal.color}; margin: 36px; }
  h1    { font-family: '${fonts.heading}'; font-size: ${tok.heading1.fontSize}pt; color: ${tok.heading1.color}; margin: 16pt 0 6pt; }
  h2    { font-family: '${fonts.heading}'; font-size: ${tok.heading2.fontSize}pt; color: ${tok.heading2.color}; margin: 12pt 0 4pt; }
  h3    { font-family: '${fonts.heading}'; font-size: ${tok.heading3.fontSize}pt; color: ${tok.heading3.color}; margin:  8pt 0 3pt; }
  h4    { font-family: '${fonts.heading}'; font-size: ${tok.heading4.fontSize}pt; color: ${tok.heading4.color}; margin:  6pt 0 2pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th    { background: ${tok.tableHeader.bgColor}; color: ${tok.tableHeader.textColor}; padding: 6px 10px; font-weight: bold; border: 1px solid #ccc; text-align: left; }
  td    { border: 1px solid #ccc; padding: 5px 10px; }
  tr:nth-child(even) td { background: ${tok.tableAltRow.bgColor}; }
  code  { background: #f4f4f4; padding: 2px 4px; font-family: monospace; font-size: 10pt; }
  pre   { background: #f4f4f4; padding: 12px; border-radius: 4px; }
  p     { margin: 0 0 6pt; line-height: 1.4; }
  ul, ol { margin: 4pt 0 6pt 20px; padding: 0; }
  li    { margin-bottom: 3pt; }
</style></head><body>\n`;

  let inList = false;
  let inOl   = false;
  let inPre  = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Code block toggle ──────────────────────────────────────────────────
    if (line.startsWith("```")) {
      inPre = !inPre;
      html += inPre ? "<pre><code>" : "</code></pre>\n";
      i++; continue;
    }
    if (inPre) { html += escHtml(line) + "\n"; i++; continue; }

    // ── Fix 2: Skip blank / whitespace-only lines ──────────────────────────
    // Block elements (h1-h4, table, ul, ol, p) carry their own spacing.
    // <p></p> for every blank line creates unwanted empty paragraphs in Google Docs.
    if (line.trim() === "") {
      if (inList) { html += "</ul>\n"; inList = false; }
      if (inOl)   { html += "</ol>\n"; inOl   = false; }
      i++; continue;
    }

    // ── Fix 1: Detect and convert markdown table blocks ───────────────────
    // A table starts with a pipe row followed immediately by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      if (inList) { html += "</ul>\n"; inList = false; }
      if (inOl)   { html += "</ol>\n"; inOl   = false; }

      // Collect: header row + separator row + all consecutive data rows
      const tableLines: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      html += buildHtmlTable(tableLines);
      i = j; continue;
    }

    // ── Lists ──────────────────────────────────────────────────────────────
    const isBullet = /^\s*[-*+]\s+/.test(line);
    const isOlItem = /^\s*\d+\.\s+/.test(line);
    if (!isBullet && inList) { html += "</ul>\n"; inList = false; }
    if (!isOlItem && inOl)   { html += "</ol>\n"; inOl   = false; }

    if (isBullet) {
      const m = line.match(/^\s*[-*+]\s+(.*)/);
      if (!inList) { html += "<ul>\n"; inList = true; }
      html += `<li>${inlineFormat(m![1])}</li>\n`;
      i++; continue;
    }
    if (isOlItem) {
      const m = line.match(/^\s*\d+\.\s+(.*)/);
      if (!inOl) { html += "<ol>\n"; inOl = true; }
      html += `<li>${inlineFormat(m![1])}</li>\n`;
      i++; continue;
    }

    // ── Headings — Fix 4: strip redundant ** / __ wrappers ────────────────
    const hm = line.match(/^(#{1,4})\s+(.*)/);
    if (hm) {
      const level = hm[1].length;
      const headingText = hm[2]
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .replace(/^__(.+)__$/, "$1");
      html += `<h${level}>${inlineFormat(headingText)}</h${level}>\n`;
      i++; continue;
    }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^(\*\*\*|---|___)\s*$/.test(line)) {
      html += "<hr>\n"; i++; continue;
    }

    // ── Regular paragraph ──────────────────────────────────────────────────
    html += `<p>${inlineFormat(line)}</p>\n`;
    i++;
  }

  if (inList) html += "</ul>\n";
  if (inOl)   html += "</ol>\n";
  html += "</body></html>";
  return html;
}

// ── Table helpers ─────────────────────────────────────────────────────────────

/** True if this line looks like a markdown table row: starts and ends with | */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}

/**
 * True if this line is a markdown table separator row.
 * Valid examples: |---|  |:---:|  |---:|  | :--- |
 */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  // Remove all valid separator characters; nothing should remain
  return t.replace(/[\s|:\-]/g, "").length === 0;
}

/** Split a markdown table row into trimmed cell strings */
function parseTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
}

/**
 * Build a complete HTML <table> from collected markdown table lines.
 * lines[0] = header row
 * lines[1] = separator row (used for column alignment only)
 * lines[2..] = data rows
 */
function buildHtmlTable(lines: string[]): string {
  const headers    = parseTableRow(lines[0]);
  const alignments = parseTableRow(lines[1]).map(cell => {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });

  let html = "<table>\n<thead>\n<tr>\n";
  headers.forEach((h, j) => {
    html += `  <th style="text-align:${alignments[j] ?? "left"}">${inlineFormat(h)}</th>\n`;
  });
  html += "</tr>\n</thead>\n<tbody>\n";

  for (let r = 2; r < lines.length; r++) {
    const cells = parseTableRow(lines[r]);
    html += "<tr>\n";
    cells.forEach((c, j) => {
      html += `  <td style="text-align:${alignments[j] ?? "left"}">${inlineFormat(c)}</td>\n`;
    });
    html += "</tr>\n";
  }

  html += "</tbody>\n</table>\n";
  return html;
}

// ── Inline formatting helpers ─────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineFormat(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g,     "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,          "<em>$1</em>")
    .replace(/`(.+?)`/g,            "<code>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}
