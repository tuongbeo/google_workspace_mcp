/**
 * Composite Tools — Phase 2A
 * High-level tools that reduce 80-90% of turns for common tasks.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { getTheme, getFontPair, deriveDocTokens, hexToSheetsRgb } from "../styles";
import type { GetCredsFunc } from "../types";

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Convert hex color to Google Docs RGB object. Reuses hexToSheetsRgb from styles. */
function hexToRgb(hex: string) { return hexToSheetsRgb(hex); }

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


  // ── import_to_google_doc (enhanced with theme) ───────────────────────────────
  // NOTE: The base import_to_google_doc lives in drive.ts (upload via multipart).
  // This enhanced version applies theme styling after upload using updateNamedStyle.


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
      html += buildHtmlTable(tableLines, tok);
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
function buildHtmlTable(
  lines: string[],
  tok: ReturnType<typeof deriveDocTokens>,
): string {
  const headers    = parseTableRow(lines[0]);
  const alignments = parseTableRow(lines[1]).map(cell => {
    const c = cell.trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });

  // Use plain <tr><td> for ALL rows — including the header.
  // Google Docs creates a spurious empty row when it sees <thead>/<th>,
  // and overrides text-align on <th> to center regardless of inline style.
  // Using styled <td> for the header row avoids both issues.
  let html = "<table>\n<tbody>\n";

  // Header row: bold + theme colors via inline style
  html += "<tr>\n";
  headers.forEach((h, j) => {
    const align = alignments[j] ?? "left";
    html += `  <td style="text-align:${align};font-weight:bold;` +
            `background-color:${tok.tableHeader.bgColor};` +
            `color:${tok.tableHeader.textColor};` +
            `border:1px solid #ccc;padding:5px 10px">${inlineFormat(h)}</td>\n`;
  });
  html += "</tr>\n";

  // Data rows: alternating background on even rows
  for (let r = 2; r < lines.length; r++) {
    const cells  = parseTableRow(lines[r]);
    const isEven = (r - 2) % 2 === 1;
    html += "<tr>\n";
    cells.forEach((c, j) => {
      const align = alignments[j] ?? "left";
      const bg    = isEven ? `background-color:${tok.tableAltRow.bgColor};` : "";
      html += `  <td style="text-align:${align};${bg}` +
              `border:1px solid #ccc;padding:5px 10px">${inlineFormat(c)}</td>\n`;
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

// ── extractTableAlignments ────────────────────────────────────────────────────
// Scan markdown and return one alignment array per table found (document order).
// Values are Google Docs paragraph alignment strings: "START" | "CENTER" | "END".

function extractTableAlignments(md: string): string[][] {
  md = md.replace(/\\([#*|`_~\[\](){}+\-.!])/g, (_, ch: string) => ch);
  const lines  = md.split("\n");
  const result: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const aligns = parseTableRow(lines[i + 1]).map(cell => {
        const c = cell.trim();
        if (c.startsWith(":") && c.endsWith(":")) return "CENTER";
        if (c.endsWith(":"))                        return "END";
        return "START";
      });
      result.push(aligns);
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) i++;
    } else { i++; }
  }
  return result;
}

/**
 * Compute proportional column widths (in PT) for each markdown table.
 *
 * Strategy:
 *   1. Find max content length per column across all rows (chars).
 *   2. Apply sqrt() to compress extremes — wide columns stay wide but
 *      narrow columns aren't crushed to unusable size.
 *   3. Give every column a guaranteed MIN_PT floor; distribute the remaining
 *      page width proportionally by sqrt score.
 *   4. Normalise to exactly pageWidthPt to avoid drift.
 *
 * Default page width = 468pt (US Letter 612pt − 2 × 72pt margins).
 */
function extractTableWidths(md: string, pageWidthPt = 468): number[][] {
  md = md.replace(/\\([#*|`_~\[\](){}+\-.!])/g, (_, ch: string) => ch);
  const lines  = md.split("\n");
  const result: number[][] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      // Collect all rows of this table
      const tableLines: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) { tableLines.push(lines[j]); j++; }

      const numCols = parseTableRow(tableLines[0]).length;
      const maxLens = new Array(numCols).fill(0) as number[];

      // Max content length per column (skip separator row at index 1)
      for (let r = 0; r < tableLines.length; r++) {
        if (r === 1) continue;
        parseTableRow(tableLines[r]).forEach((cell, c) => {
          if (c < numCols) maxLens[c] = Math.max(maxLens[c], cell.length);
        });
      }

      // sqrt compression + MIN_PT floor
      const MIN_PT      = 48;
      const sqrts       = maxLens.map(l => Math.sqrt(Math.max(l, 1)));
      const sqrtSum     = sqrts.reduce((a, b) => a + b, 0);
      const distributable = Math.max(0, pageWidthPt - MIN_PT * numCols);

      const widths = sqrts.map(s =>
        Math.round(MIN_PT + (s / sqrtSum) * distributable)
      );

      // Fix rounding drift so columns sum to exactly pageWidthPt
      const drift = pageWidthPt - widths.reduce((a, b) => a + b, 0);
      widths[widths.length - 1] += drift;

      result.push(widths);
      i = j;
    } else { i++; }
  }
  return result;
}
