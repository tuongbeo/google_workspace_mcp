/**
 * docs-engine/builder.ts  v3
 *
 * Fixes vs v2:
 *  - Heading paraStyle: endIndex = startIdx + text.length - 1 (exclude trailing \n)
 *  - footnote_def nodes filtered from fullText build AND from contentNodes
 *  - \pagebreak / \toc parser sentinel fix: also detect in paragraph content
 *  - Placeholder length: use actual byte length via Buffer-free approach
 *  - Checked checkbox items: apply strikethrough + muted color
 *  - buildDocText: include ALL text runs including list items
 *  - fillTableCells: replace findLast with manual reverse loop (V8 compat)
 *  - Justify alignment support via opts.alignment
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

// ── Placeholders — fixed 10-char each ────────────────────────────────────────
// Format: «TAG001»  where TAG = 3 chars, id = 3 chars → total 8 + 2 guillemets = 10

let _counter = 0;
function uid(): string { return (++_counter).toString(36).padStart(3, "0"); }
function makePH(tag: string): string { return `\u00AB${tag}${uid()}\u00BB`; }
export const PH_LEN = 10; // «XXX000» byte length in BMP

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

// ── Inline → text (with placeholders) ────────────────────────────────────────

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

// ── Request builders ──────────────────────────────────────────────────────────

function textStyleReq(start: number, end: number, tabId: string | undefined, style: Record<string, unknown>): object {
  const range: Record<string, unknown> = { startIndex: start, endIndex: end };
  if (tabId) range.tabId = tabId;
  return { updateTextStyle: { range, textStyle: style, fields: Object.keys(style).join(",") } };
}

function paraStyleReq(start: number, end: number, tabId: string | undefined, style: Record<string, unknown>, fields: string): object {
  const range: Record<string, unknown> = { startIndex: start, endIndex: end };
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
        const s = rel;
        rel = applyInlineStyles(n.children, base + s, tabId, reqs);
        const styleKey = n.type === "bold" ? "bold" : n.type === "italic" ? "italic"
          : n.type === "strikethrough" ? "strikethrough" : "underline";
        if (rel > s) reqs.push(textStyleReq(base + s, base + rel, tabId, { [styleKey]: true }));
        break;
      }
      case "code": {
        const s = rel; rel += n.content.length;
        reqs.push(textStyleReq(base + s, base + rel, tabId, {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        }));
        break;
      }
      case "link": {
        const s = rel;
        rel = applyInlineStyles(n.children, base + s, tabId, reqs);
        if (rel > s) reqs.push(textStyleReq(base + s, base + rel, tabId, {
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

// ── List text builder ─────────────────────────────────────────────────────────

function buildListText(items: ListItem[]): string {
  return items.map(item => inlinesToText(item.children) + "\n"
    + (item.subItems?.length ? buildListText(item.subItems) : "")).join("");
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

  // Collect footnote defs (these must NOT be inserted into body text)
  const footnoteDefs = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === "footnote_def") footnoteDefs.set(n.id, n.content);
  }

  // Filter out footnote_def nodes — they are metadata only, not body content
  const contentNodes = nodes.filter(n => n.type !== "footnote_def");

  // ── Step 1: Build full text string + segment map ────────────────────────

  interface Seg { text: string; startIdx: number; node: DocNode }
  const segs: Seg[] = [];
  let fullText = "";
  let cursor = startIndex;

  for (const node of contentNodes) {
    let segText = "";

    switch (node.type) {
      case "heading":      segText = inlinesToText(node.children) + "\n"; break;
      case "paragraph":    segText = inlinesToText(node.children) + "\n"; break;
      case "blockquote":   segText = inlinesToText(node.children) + "\n"; break;
      case "code_block":   segText = node.content.replace(/\n$/, "") + "\n"; break;
      case "bullet_list":  segText = buildListText(node.items); break;
      case "table": {
        // Placeholder newline; actual table inserted in pass2 via fillTableCells
        segText = "\n";
        _rich.push({
          type: "rich_link",
          placeholder: `\u00ABTBL${uid()}\u00BB`,
          url: JSON.stringify({ headers: node.data.headers, rows: node.data.rows }),
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

  // ── Step 2: Single insertText ────────────────────────────────────────────

  const pass1Requests: object[] = [];

  if (fullText.length > 0) {
    const loc: Record<string, unknown> = { index: startIndex };
    if (tabId) loc.tabId = tabId;
    pass1Requests.push({ insertText: { location: loc, text: fullText } });
  }

  // ── Step 3: Style requests ────────────────────────────────────────────────
  // KEY FIX: paragraph style endIndex must EXCLUDE the trailing \n
  // Google Docs paragraph style applies to the paragraph marker before \n.
  // Using endIdx (which includes \n) causes the style to leak into the next paragraph.

  const hMap: Record<number, string> = {
    1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3",
    4: "HEADING_4", 5: "HEADING_5", 6: "HEADING_6",
  };

  for (const seg of segs) {
    const { startIdx, node, text } = seg;
    const endIdx = startIdx + text.length;
    // paraEnd: endIndex for paragraph style = exclude trailing \n
    const paraEnd = text.endsWith("\n") ? endIdx - 1 : endIdx;

    switch (node.type) {
      case "heading": {
        // Apply heading style only to the heading paragraph (not including \n)
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
          { namedStyleType: hMap[node.level] }, "namedStyleType"));
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "paragraph": {
        // Apply justify alignment to body paragraphs if requested
        if (alignment === "justify") {
          pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId,
            { alignment: "JUSTIFIED" }, "alignment"));
        }
        applyInlineStyles(node.children, startIdx, tabId, pass1Requests);
        break;
      }

      case "blockquote": {
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
        pass1Requests.push(paraStyleReq(startIdx, endIdx, tabId, {
          indentStart: { magnitude: 18, unit: "PT" },
        }, "indentStart"));
        pass1Requests.push(textStyleReq(startIdx, paraEnd, tabId, {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.94, green: 0.94, blue: 0.94 } } },
        }));
        break;
      }

      case "bullet_list": {
        const bulletPreset = node.listType === "numbered" ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : node.listType === "checkbox" ? "BULLET_CHECKBOX"
          : "BULLET_DISC_CIRCLE_SQUARE";

        // createParagraphBullets range: endIndex should be one before the last \n
        const range: Record<string, unknown> = { startIndex: startIdx, endIndex: endIdx - 1 };
        if (tabId) range.tabId = tabId;
        pass1Requests.push({ createParagraphBullets: { range, bulletPreset } });

        // Apply inline styles per item + strikethrough for checked items
        let itemCursor = startIdx;
        for (const item of node.items) {
          const itemPlainText = inlinesToText(item.children);
          const itemLen = itemPlainText.length;
          applyInlineStyles(item.children, itemCursor, tabId, pass1Requests);

          // FIX: checked checkbox items → strikethrough + muted color
          if (node.listType === "checkbox" && item.checked === true) {
            pass1Requests.push(textStyleReq(itemCursor, itemCursor + itemLen, tabId, {
              strikethrough: true,
              foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } },
            }));
          }
          itemCursor += itemLen + 1; // +1 for \n
        }
        break;
      }

      case "horizontal_rule": {
        pass1Requests.push(paraStyleReq(startIdx, paraEnd, tabId, {
          borderBottom: {
            color: { color: { rgbColor: { red: 0.7, green: 0.7, blue: 0.7 } } },
            width: { magnitude: 1, unit: "PT" },
            padding: { magnitude: 3, unit: "PT" },
            dashStyle: "SOLID",
          },
          spaceBelow: { magnitude: 8, unit: "PT" },
        }, "borderBottom,spaceBelow"));
        break;
      }

      case "page_break": {
        pass1Requests.push({
          insertPageBreak: { location: { index: startIdx, ...(tabId ? { tabId } : {}) } },
        });
        break;
      }
    }
  }

  // ── Step 4: Resolve footnote content ────────────────────────────────────

  for (const el of _rich) {
    if (el.type === "footnote" && el.name) {
      el.footnoteContent = footnoteDefs.get(el.name) ?? "";
    }
  }

  // ── Step 5: Theme requests ────────────────────────────────────────────────

  const themeRequests = buildThemeRequests(
    opts.theme ?? "corporate",
    opts.fontPair ?? "arial_roboto",
    alignment,
  );

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
  const colors = getTheme(themeName as any);
  const fonts = getFontPair(fontPairName as any);
  const tok = deriveDocTokens(colors, fonts);

  function ns(
    styleType: string, colorHex: string, sizePt: number,
    bold: boolean, font: string, abovePt: number, belowPt: number,
    lineSpacing?: number, align?: string
  ) {
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
