/**
 * docs-engine/builder.ts  v4
 * CRITICAL FIX: All non-heading paragraphs now explicitly set NORMAL_TEXT
 * to prevent Google Docs from inheriting heading style from previous paragraph.
 */

import type { DocNode, InlineNode, ListItem, RichElement, ExecutionPlan } from "./types";
import { getTheme, getFontPair, deriveDocTokens } from "../styles";

export function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// ── Placeholders — ASCII-safe ─────────────────────────────────────────────────
// Format: __TAG_NNN__  = 12 chars (safe for Google Docs replaceAllText API)

let _counter = 0;
function uid(): string { return (++_counter).toString(10).padStart(3, "0"); }
function makePH(tag: string): string { return `__${tag}_${uid()}__`; }
export const PH_LEN = 12; // __XXX_NNN__ = 12 chars

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

// ── Request helpers ───────────────────────────────────────────────────────────

function textStyleReq(s: number, e: number, tabId: string | undefined, style: Record<string, unknown>): object {
  const range: Record<string, unknown> = { startIndex: s, endIndex: e };
  if (tabId) range.tabId = tabId;
  return { updateTextStyle: { range, textStyle: style, fields: Object.keys(style).join(",") } };
}

function paraStyleReq(s: number, e: number, tabId: string | undefined, style: Record<string, unknown>, fields: string): object {
  const range: Record<string, unknown> = { startIndex: s, endIndex: e };
  if (tabId) range.tabId = tabId;
  return { updateParagraphStyle: { range, paragraphStyle: style, fields } };
}

// ── Inline style walker ───────────────────────────────────────────────────────

function applyInlineStyles(nodes: InlineNode[], base: number, tabId: string | undefined, reqs: object[]): number {
  let rel = 0;
  for (const n of nodes) {
    switch (n.type) {
      case "text": rel += n.content.length; break;
      case "bold": case "italic": case "strikethrough": case "underline": {
        const start = rel;
        rel = applyInlineStyles(n.children, base + start, tabId, reqs);
        const key = n.type === "bold" ? "bold" : n.type === "italic" ? "italic"
          : n.type === "strikethrough" ? "strikethrough" : "underline";
        if (rel > start) reqs.push(textStyleReq(base + start, base + rel, tabId, { [key]: true }));
        break;
      }
      case "code": {
        const start = rel; rel += n.content.length;
        reqs.push(textStyleReq(base + start, base + rel, tabId, {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        }));
        break;
      }
      case "link": {
        const start = rel;
        rel = applyInlineStyles(n.children, base + start, tabId, reqs);
        if (rel > start) reqs.push(textStyleReq(base + start, base + rel, tabId, {
          link: { url: n.url },
          foregroundColor: { color: { rgbColor: { red: 0.07, green: 0.36, blue: 0.8 } } },
          underline: true,
        }));
        break;
      }
      case "mention": rel += PH_LEN; break;
      case "footnote_ref": rel += PH_LEN; break;
      case "image": rel += PH_LEN; break;
      default: break;
    }
  }
  return rel;
}

// ── List text ─────────────────────────────────────────────────────────────────

function buildListText(items: ListItem[]): string {
  return items.map(item =>
    inlinesToText(item.children) + "\n" +
    (item.subItems?.length ? buildListText(item.subItems) : "")
  ).join("");
}

/**
 * Apply per-item paragraph/text styling for a list, recursing into subItems
 * in the same order buildListText() wrote their text — parent text, then
 * its subItems' text, then the next sibling. Returns the cursor position
 * just past the last item processed (including all of its subItems), so a
 * caller iterating sibling items keeps its own cursor in sync.
 */
function applyListItemStyles(
  items: ListItem[],
  cursor: number,
  depth: number,
  listType: "bullet" | "numbered" | "checkbox",
  tabId: string | undefined,
  pass1Requests: object[],
): number {
  for (const item of items) {
    const itemText = inlinesToText(item.children);
    const itemLen = itemText.length;
    const itemParaEnd = cursor + itemLen;
    if (itemParaEnd > cursor) {
      if (depth > 0) {
        pass1Requests.push(paraStyleReq(cursor, itemParaEnd, tabId, {
          namedStyleType: "NORMAL_TEXT",
          indentFirstLine: { magnitude: 18 * depth, unit: "PT" },
          indentStart:     { magnitude: 18 * depth, unit: "PT" },
        }, "namedStyleType,indentFirstLine,indentStart"));
      } else {
        pass1Requests.push(paraStyleReq(cursor, itemParaEnd, tabId,
          { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
      }
    }
    applyInlineStyles(item.children, cursor, tabId, pass1Requests);
    // Checked item → strikethrough + muted
    if (listType === "checkbox" && item.checked === true && itemParaEnd > cursor) {
      pass1Requests.push(textStyleReq(cursor, itemParaEnd, tabId, {
        strikethrough: true,
        foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
      }));
    }
    cursor = itemParaEnd + 1; // +1 for \n
    if (item.subItems?.length) {
      cursor = applyListItemStyles(item.subItems, cursor, depth + 1, listType, tabId, pass1Requests);
    }
  }
  return cursor;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildExecutionPlan(
  nodes: DocNode[],
  opts: {
    theme?: string;
    fontPair?: string;
    startIndex?: number;
    tabId?: string;
    alignment?: "left" | "justify";
  } = {}
): ExecutionPlan {
  _counter = 0;
  _rich = [];

  const startIndex = opts.startIndex ?? 1;
  const tabId = opts.tabId;
  const alignment = opts.alignment ?? "left";

  // Collect footnote defs (NOT inserted into body)
  const footnoteDefs = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === "footnote_def") footnoteDefs.set(n.id, n.content);
  }

  const contentNodes = nodes.filter(n => n.type !== "footnote_def");

  // ── Build full text string ────────────────────────────────────────────────

  interface Seg { text: string; startIdx: number; node: DocNode }
  const segs: Seg[] = [];
  let fullText = "";
  let cursor = startIndex;

  for (const node of contentNodes) {
    let segText = "";
    switch (node.type) {
      case "heading":         segText = inlinesToText(node.children) + "\n"; break;
      case "paragraph":       segText = inlinesToText(node.children) + "\n"; break;
      case "blockquote":      segText = inlinesToText(node.children) + "\n"; break;
      case "code_block":      segText = node.content.replace(/\n$/, "") + "\n"; break;
      case "bullet_list":     segText = buildListText(node.items); break;
      case "table": {
        // Insert placeholder text (will be replaced by actual table in pass2)
        const tblPH = makePH("TBL");
        segText = tblPH + "\n";
        _rich.push({
          type: "rich_link",
          placeholder: tblPH,
          url: JSON.stringify({
            headers: node.data.headers,
            rows: node.data.rows,
            nRows: node.data.rows.length + 1,
            nCols: node.data.headers.length,
          }),
        });
        break;
      }
      case "horizontal_rule": segText = "\n"; break;
      case "page_break":      segText = "\n"; break;
      case "toc":             segText = tocPH() + "\n"; break;
      case "image":           segText = imgPH(node.url, node.alt, node.widthPt, node.heightPt) + "\n"; break;
      default:                segText = "\n"; break;
    }
    segs.push({ text: segText, startIdx: cursor, node });
    fullText += segText;
    cursor += segText.length;
  }

  // ── Single insertText ─────────────────────────────────────────────────────

  const pass1Requests: object[] = [];

  if (fullText.length > 0) {
    const loc: Record<string, unknown> = { index: startIndex };
    if (tabId) loc.tabId = tabId;
    pass1Requests.push({ insertText: { location: loc, text: fullText } });
  }

  // ── Style requests ────────────────────────────────────────────────────────
  //
  // CRITICAL RULE: Every segment that is NOT a heading must explicitly set
  // namedStyleType = "NORMAL_TEXT". Google Docs inherits the namedStyleType
  // from the previous paragraph when text is inserted, so after a heading the
  // next paragraph will silently become that heading style unless overridden.

  const hMap: Record<number, string> = {
    1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3",
    4: "HEADING_4", 5: "HEADING_5", 6: "HEADING_6",
  };

  for (const seg of segs) {
    const { startIdx, node, text } = seg;
    const endIdx = startIdx + text.length;
    // paraEnd excludes trailing \n — prevents style leaking to next paragraph
    const paraEnd = text.endsWith("\n") ? endIdx - 1 : endIdx;

    // NOTE: paraEnd may equal startIdx for single-\n segments (HR, page_break, table, image)
    // Those cases use endIdx directly below, so we only skip truly empty segments
    if (endIdx <= startIdx) continue;

    switch (node.type) {

      case "heading": {
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
          { namedStyleType: hMap[node.level] }, "namedStyleType"));
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "paragraph": {
        // Always reset to NORMAL_TEXT — prevents H2 inheritance from previous heading
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
          { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
        if (alignment === "justify") {
          pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
            { alignment: "JUSTIFIED" }, "alignment"));
        }
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "blockquote": {
        // Reset to NORMAL_TEXT then apply blockquote indent+style
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
          { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId, {
          indentStart: { magnitude: 36, unit: "PT" },
          indentFirstLine: { magnitude: 0, unit: "PT" },
          ...(alignment === "justify" ? { alignment: "JUSTIFIED" } : {}),
        }, `indentStart,indentFirstLine${alignment === "justify" ? ",alignment" : ""}`));
        pass1Requests.push(textStyleReq(startIdx, paraEnd, tabId, {
          italic: true,
          foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } },
        }));
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "code_block": {
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
          { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId,
          { indentStart: { magnitude: 18, unit: "PT" } }, "indentStart"));
        if (paraEnd > startIdx) {
          pass1Requests.push(textStyleReq(startIdx, paraEnd, tabId, {
            weightedFontFamily: { fontFamily: "Roboto Mono" },
            fontSize: { magnitude: 10, unit: "PT" },
            backgroundColor: { color: { rgbColor: { red: 0.94, green: 0.94, blue: 0.94 } } },
          }));
        }
        break;
      }

      case "bullet_list": {
        const bulletPreset = node.listType === "numbered" ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : node.listType === "checkbox" ? "BULLET_CHECKBOX"
          : "BULLET_DISC_CIRCLE_SQUARE";
        const range: Record<string, unknown> = { startIndex: startIdx, endIndex: endIdx - 1 };
        if (tabId) range.tabId = tabId;
        pass1Requests.push({ createParagraphBullets: { range, bulletPreset } });

        // Reset each list item (recursively, including nested subItems) to
        // NORMAL_TEXT. Must recurse in lockstep with buildListText() above,
        // which already wove subItems' text in right after their parent —
        // a flat loop over top-level items only would drift out of sync with
        // the actual inserted text as soon as any item had subItems.
        applyListItemStyles(node.items, startIdx, 0, node.listType, tabId, pass1Requests);
        break;
      }

      case "horizontal_rule": {
        // HR paragraph has segText="\n" so endIdx = startIdx+1
        // Apply borderBottom to the full range including the \n char
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          namedStyleType: "NORMAL_TEXT",
          borderBottom: {
            color: { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } },
            width: { magnitude: 1, unit: "PT" },
            padding: { magnitude: 4, unit: "PT" },
            dashStyle: "SOLID",
          },
          spaceAbove: { magnitude: 8, unit: "PT" },
          spaceBelow: { magnitude: 8, unit: "PT" },
        }, "namedStyleType,borderBottom,spaceAbove,spaceBelow"));
        break;
      }

      case "page_break": {
        // Use pageBreakBefore on the NEXT paragraph instead of insertPageBreak.
        // insertPageBreak inserts an extra char that shifts all subsequent indices.
        // pageBreakBefore is a paragraph style that forces a page break before the
        // paragraph WITHOUT inserting extra content — no index drift.
        // We apply it to the \n paragraph itself (startIdx..endIdx).
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          namedStyleType: "NORMAL_TEXT",
          pageBreakBefore: true,
          spaceAbove: { magnitude: 0, unit: "PT" },
          spaceBelow: { magnitude: 0, unit: "PT" },
        }, "namedStyleType,pageBreakBefore,spaceAbove,spaceBelow"));
        break;
      }

      case "table": {
        // The \n placeholder paragraph — reset to NORMAL_TEXT
        if (paraEnd > startIdx) {
          pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
            { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
        }
        break;
      }

      case "image": {
        // The image placeholder paragraph — reset to NORMAL_TEXT
        if (paraEnd > startIdx) {
          pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
            { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
        }
        break;
      }
    }
  }

  // ── Resolve footnote content ──────────────────────────────────────────────

  for (const el of _rich) {
    if (el.type === "footnote" && el.name) {
      el.footnoteContent = footnoteDefs.get(el.name) ?? "";
    }
  }

  // ── Theme requests ────────────────────────────────────────────────────────

  const themeRequests = buildThemeRequests(opts.theme ?? "corporate", opts.fontPair ?? "arial_roboto", alignment);

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

function buildThemeRequests(themeName: string, fontPairName: string, alignment: string): object[] {
  const colors = getTheme(themeName);
  const fonts = getFontPair(fontPairName);
  const tok = deriveDocTokens(colors, fonts);

  function ns(styleType: string, colorHex: string, sizePt: number, bold: boolean, font: string,
              abovePt: number, belowPt: number, lineSpacing?: number, align?: string) {
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
            ...(align ? { alignment: align } : {}),
          },
        },
        fields: "*",
      },
    };
  }

  const bodyAlign = alignment === "justify" ? "JUSTIFIED" : undefined;

  return [
    ns("NORMAL_TEXT", tok.normal.color, tok.normal.fontSize, false, tok.normal.fontFamily, 0, 6, 115, bodyAlign),
    ns("HEADING_1",   tok.heading1.color, tok.heading1.fontSize, tok.heading1.bold, tok.heading1.fontFamily, 16, 6),
    ns("HEADING_2",   tok.heading2.color, tok.heading2.fontSize, tok.heading2.bold, tok.heading2.fontFamily, 14, 4),
    ns("HEADING_3",   tok.heading3.color, tok.heading3.fontSize, tok.heading3.bold, tok.heading3.fontFamily, 12, 4),
    ns("HEADING_4",   tok.heading4.color, tok.heading4.fontSize, tok.heading4.bold, tok.heading4.fontFamily, 10, 2),
    ns("HEADING_5",   tok.heading4.color, 11, false, tok.heading4.fontFamily, 8, 2),
    ns("HEADING_6",   tok.heading4.color, 11, false, tok.heading4.fontFamily, 6, 2),
    ns("TITLE",       tok.heading1.color, 26, true,  tok.heading1.fontFamily, 0, 10),
    ns("SUBTITLE",    tok.heading2.color, 14, false, tok.heading2.fontFamily, 0, 8),
  ];
}
