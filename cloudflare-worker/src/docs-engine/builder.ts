/**
 * docs-engine/builder.ts  v2
 * AST → Google Docs batchUpdate requests
 *
 * Approach (proven, simple):
 *   1. Build full document text as ONE string
 *   2. Insert all text in ONE insertText request at startIndex
 *   3. Track per-segment character ranges
 *   4. Apply paragraph styles + inline styles + bullets using those ranges
 *   5. Collect rich elements (images, mentions, footnotes, TOC) as placeholders
 *
 * This avoids all reverse-order index complexity by doing a single text insert.
 */

import type { DocNode, InlineNode, ListItem, RichElement, ExecutionPlan } from "./types";
import { getTheme, getFontPair, deriveDocTokens } from "../styles";

// ── Hex → RGB ────────────────────────────────────────────────────────────────

export function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// ── Placeholder IDs ───────────────────────────────────────────────────────────

let _counter = 0;
function uid(): string {
  return (++_counter).toString(36).padStart(3, "0");
}
// Use short fixed-length placeholders so we can count characters accurately
// Format: \u00AB + 8 chars + \u00BB  = 10 chars total, very unlikely in real text
function makePH(tag: string): string {
  return `\u00AB${tag}${uid()}\u00BB`; // «TAG001»
}

// Rich element registry for this build
let _rich: RichElement[] = [];

function imgPH(url: string, alt?: string, w?: number, h?: number): string {
  const ph = makePH("IMG");
  _rich.push({ type: "image", placeholder: ph, url, widthPt: w, heightPt: h });
  return ph;
}
function mentionPH(name: string, email: string): string {
  const ph = makePH("MNT");
  _rich.push({ type: "mention", placeholder: ph, name, email });
  return ph;
}
function footnotePH(refId: string): string {
  const ph = makePH("FNT");
  _rich.push({ type: "footnote", placeholder: ph, name: refId });
  return ph;
}
function tocPH(): string {
  const ph = makePH("TOC");
  _rich.push({ type: "toc", placeholder: ph });
  return ph;
}

// ── Inline → plain text ───────────────────────────────────────────────────────

function inlinesToText(nodes: InlineNode[]): string {
  return nodes.map(n => {
    switch (n.type) {
      case "text": return n.content;
      case "bold": case "italic": case "strikethrough": case "underline":
        return inlinesToText(n.children);
      case "code": return n.content;
      case "link": return inlinesToText(n.children);
      case "mention": return mentionPH(n.name, n.email);
      case "footnote_ref": return footnotePH(n.id);
      case "image": return imgPH(n.url, n.alt, n.widthPt, n.heightPt);
      default: return "";
    }
  }).join("");
}

// ── Per-segment metadata ──────────────────────────────────────────────────────

interface Seg {
  text: string;           // raw text including \n
  startIdx: number;       // absolute start in doc (1-based)
  node: DocNode;
  listType?: "bullet" | "numbered" | "checkbox";
}

// ── Inline style walker ───────────────────────────────────────────────────────

function applyInlineStyles(
  nodes: InlineNode[],
  baseDocIdx: number,  // absolute doc index of paragraph start
  tabId: string | undefined,
  requests: object[]
): number {
  let rel = 0;
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        rel += n.content.length;
        break;
      case "bold":
      case "italic":
      case "strikethrough":
      case "underline": {
        const start = rel;
        rel = applyInlineStyles(n.children, baseDocIdx + start, tabId, requests);
        // rel is now relative end; convert to absolute
        const absStart = baseDocIdx + start;
        const absEnd = baseDocIdx + rel;
        const styleKey = n.type === "bold" ? "bold"
          : n.type === "italic" ? "italic"
          : n.type === "strikethrough" ? "strikethrough"
          : "underline";
        if (absEnd > absStart) {
          requests.push(textStyleReq(absStart, absEnd, tabId, { [styleKey]: true }));
        }
        break;
      }
      case "code": {
        const start = rel;
        rel += n.content.length;
        requests.push(textStyleReq(baseDocIdx + start, baseDocIdx + rel, tabId, {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        }));
        break;
      }
      case "link": {
        const start = rel;
        rel = applyInlineStyles(n.children, baseDocIdx + start, tabId, requests);
        const absStart = baseDocIdx + start;
        const absEnd = baseDocIdx + rel;
        if (absEnd > absStart) {
          requests.push(textStyleReq(absStart, absEnd, tabId, {
            link: { url: n.url },
            foregroundColor: { color: { rgbColor: { red: 0.07, green: 0.36, blue: 0.8 } } },
            underline: true,
          }));
        }
        break;
      }
      case "mention":
        rel += 10; // «MNTxxx» = 10 chars
        break;
      case "footnote_ref":
        rel += 10;
        break;
      case "image":
        rel += 10;
        break;
      default:
        break;
    }
  }
  return rel;
}

function textStyleReq(start: number, end: number, tabId: string | undefined, style: Record<string, unknown>): object {
  const range: Record<string, unknown> = { startIndex: start, endIndex: end };
  if (tabId) range.tabId = tabId;
  return {
    updateTextStyle: {
      range,
      textStyle: style,
      fields: Object.keys(style).join(","),
    },
  };
}

function paraStyleReq(start: number, end: number, tabId: string | undefined, style: Record<string, unknown>, fields: string): object {
  const range: Record<string, unknown> = { startIndex: start, endIndex: end };
  if (tabId) range.tabId = tabId;
  return { updateParagraphStyle: { range, paragraphStyle: style, fields } };
}

// ── Build list text ───────────────────────────────────────────────────────────

function buildListText(items: ListItem[]): string {
  return items.map(item => {
    const text = inlinesToText(item.children) + "\n";
    const sub = item.subItems?.length ? buildListText(item.subItems) : "";
    return text + sub;
  }).join("");
}

// ── Main build function ───────────────────────────────────────────────────────

export function buildExecutionPlan(
  nodes: DocNode[],
  opts: { theme?: string; fontPair?: string; startIndex?: number; tabId?: string } = {}
): ExecutionPlan {
  _counter = 0;
  _rich = [];

  const startIndex = opts.startIndex ?? 1;
  const tabId = opts.tabId;

  // Collect footnote defs
  const footnoteDefs = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === "footnote_def") footnoteDefs.set(n.id, n.content);
  }

  // ── Step 1: Build full text and segment map ──────────────────────────────

  const contentNodes = nodes.filter(n => n.type !== "footnote_def");
  const segs: Seg[] = [];
  let fullText = "";
  let cursor = startIndex;

  for (const node of contentNodes) {
    let segText = "";

    switch (node.type) {
      case "heading":
        segText = inlinesToText(node.children) + "\n";
        break;
      case "paragraph":
        segText = inlinesToText(node.children) + "\n";
        break;
      case "blockquote":
        segText = inlinesToText(node.children) + "\n";
        break;
      case "code_block":
        segText = node.content.replace(/\n$/, "") + "\n";
        break;
      case "bullet_list":
        segText = buildListText(node.items);
        break;
      case "table": {
        // Table is handled specially: insert a sentinel newline, table goes in pass2
        segText = "\n";
        _rich.push({
          type: "rich_link",
          placeholder: `\u00ABTBL${uid()}\u00BB`,
          url: JSON.stringify({ headers: node.data.headers, rows: node.data.rows }),
        });
        break;
      }
      case "horizontal_rule":
        segText = "\n"; // HR inserted separately
        break;
      case "page_break":
        segText = "\n";
        break;
      case "toc":
        segText = tocPH() + "\n";
        break;
      case "image": {
        segText = imgPH(node.url, node.alt, node.widthPt, node.heightPt) + "\n";
        break;
      }
      default:
        segText = "\n";
    }

    segs.push({ text: segText, startIdx: cursor, node });
    fullText += segText;
    cursor += segText.length;
  }

  // ── Step 2: Single insertText for all content ────────────────────────────

  const pass1Requests: object[] = [];

  if (fullText.length > 0) {
    const loc: Record<string, unknown> = { index: startIndex };
    if (tabId) loc.tabId = tabId;
    pass1Requests.push({ insertText: { location: loc, text: fullText } });
  }

  // ── Step 3: Apply styles (after text is inserted) ────────────────────────

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const { startIdx, node, text } = seg;
    const endIdx = startIdx + text.length;

    switch (node.type) {
      case "heading": {
        const hMap: Record<number, string> = {
          1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3",
          4: "HEADING_4", 5: "HEADING_5", 6: "HEADING_6"
        };
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId,
          { namedStyleType: hMap[node.level] }, "namedStyleType"));
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "paragraph":
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;

      case "blockquote":
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          indentStart: { magnitude: 36, unit: "PT" },
          indentFirstLine: { magnitude: 0, unit: "PT" },
        }, "indentStart,indentFirstLine"));
        pass1Requests.push(textStyleReq(startIdx, endIdx - 1, tabId, {
          italic: true,
          foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } },
        }));
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;

      case "code_block":
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          indentStart: { magnitude: 18, unit: "PT" },
        }, "indentStart"));
        pass1Requests.push(textStyleReq(startIdx, endIdx - 1, tabId, {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        }));
        break;

      case "bullet_list": {
        const bulletPreset = node.listType === "numbered" ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : node.listType === "checkbox" ? "BULLET_CHECKBOX"
          : "BULLET_DISC_CIRCLE_SQUARE";
        const range: Record<string, unknown> = { startIndex: startIdx, endIndex: endIdx - 1 };
        if (tabId) range.tabId = tabId;
        pass1Requests.push({ createParagraphBullets: { range, bulletPreset } });

        // Apply inline styles per item
        let itemCursor = startIdx;
        for (const item of node.items) {
          const itemText = inlinesToText(item.children);
          applyInlineStyles(item.children, itemCursor, tabId, pass1Requests);
          itemCursor += itemText.length + 1; // +1 for \n
        }
        break;
      }

      case "horizontal_rule": {
        // Google Docs API does not have insertHorizontalRule
        // Workaround: apply bottom border to the paragraph
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          borderBottom: {
            color: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
            width: { magnitude: 1, unit: "PT" },
            padding: { magnitude: 2, unit: "PT" },
            dashStyle: "SOLID",
          },
          spaceBelow: { magnitude: 8, unit: "PT" },
        }, "borderBottom,spaceBelow"));
        break;
      }

      case "page_break": {
        pass1Requests.push({ insertPageBreak: { location: { index: startIdx, ...(tabId ? { tabId } : {}) } } });
        break;
      }
    }
  }

  // ── Step 4: Fill footnote content in richElements ─────────────────────────

  for (const el of _rich) {
    if (el.type === "footnote" && el.name) {
      el.footnoteContent = footnoteDefs.get(el.name) ?? "";
    }
  }

  // ── Step 5: Theme requests ────────────────────────────────────────────────

  const themeRequests = buildThemeRequests(opts.theme ?? "corporate", opts.fontPair ?? "arial_roboto");

  const stats = {
    sections: contentNodes.filter(n => n.type === "heading").length,
    tables: contentNodes.filter(n => n.type === "table").length,
    images: _rich.filter(e => e.type === "image").length,
    mentions: _rich.filter(e => e.type === "mention").length,
    footnotes: _rich.filter(e => e.type === "footnote").length,
    hasToc: contentNodes.some(n => n.type === "toc"),
  };

  return { pass1Requests, richElements: [..._rich], themeRequests, stats };
}

// ── Theme requests ────────────────────────────────────────────────────────────

function buildThemeRequests(themeName: string, fontPairName: string): object[] {
  const colors = getTheme(themeName as any);
  const fonts = getFontPair(fontPairName as any);
  const tok = deriveDocTokens(colors, fonts);

  function ns(styleType: string, colorHex: string, sizePt: number, bold: boolean, font: string, abovePt: number, belowPt: number, lineSpacing?: number) {
    return {
      updateNamedStyle: {
        namedStyle: {
          namedStyleType: styleType,
          textStyle: {
            foregroundColor: { color: { rgbColor: hexToRgb(colorHex) } },
            fontSize: { magnitude: sizePt, unit: "PT" },
            bold,
            weightedFontFamily: { fontFamily: font },
          },
          paragraphStyle: {
            spaceAbove: { magnitude: abovePt, unit: "PT" },
            spaceBelow: { magnitude: belowPt, unit: "PT" },
            ...(lineSpacing ? { lineSpacing } : {}),
          },
        },
        fields: "*",
      },
    };
  }

  return [
    ns("NORMAL_TEXT", tok.normal.color, tok.normal.fontSize, false, tok.normal.fontFamily, 0, 6, 115),
    ns("HEADING_1", tok.heading1.color, tok.heading1.fontSize, tok.heading1.bold, tok.heading1.fontFamily, 16, 6),
    ns("HEADING_2", tok.heading2.color, tok.heading2.fontSize, tok.heading2.bold, tok.heading2.fontFamily, 14, 4),
    ns("HEADING_3", tok.heading3.color, tok.heading3.fontSize, tok.heading3.bold, tok.heading3.fontFamily, 12, 4),
    ns("HEADING_4", tok.heading4.color, tok.heading4.fontSize, tok.heading4.bold, tok.heading4.fontFamily, 10, 2),
    ns("HEADING_5", tok.heading4.color, 11, false, tok.heading4.fontFamily, 8, 2),
    ns("HEADING_6", tok.heading4.color, 11, false, tok.heading4.fontFamily, 6, 2),
    ns("TITLE", tok.heading1.color, 26, true, tok.heading1.fontFamily, 0, 10),
    ns("SUBTITLE", tok.heading2.color, 14, false, tok.heading2.fontFamily, 0, 8),
  ];
}
