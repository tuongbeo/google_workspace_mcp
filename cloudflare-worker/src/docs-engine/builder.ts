/**
 * docs-engine/builder.ts
 * AST → ordered Google Docs batchUpdate requests
 *
 * Strategy:
 *   Pass 1: Insert all text content in REVERSE order (avoid index drift),
 *           apply paragraph styles, create bullets, table structure
 *   Pass 2: Caller re-reads doc, finds placeholders, inserts rich elements
 *           (images, mentions, footnotes, TOC) via separate batchUpdate
 *   Pass 3: Theme (updateNamedStyle × N) — applied once after doc creation
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

// ── Placeholder generator ────────────────────────────────────────────────────

let _placeholderCounter = 0;
function makePlaceholder(type: string): string {
  _placeholderCounter++;
  return `\u27E8${type}:${_placeholderCounter.toString(36)}\u27E9`; // ⟨TYPE:id⟩
}

// ── Inline → plain text (for text insertion pass) ────────────────────────────

function inlinesToText(nodes: InlineNode[]): string {
  return nodes.map(n => {
    switch (n.type) {
      case "text": return n.content;
      case "bold": case "italic": case "strikethrough": case "underline":
        return inlinesToText(n.children);
      case "code": return n.content;
      case "link": return inlinesToText(n.children);
      case "mention": return makeMentionPlaceholder(n.name, n.email);
      case "footnote_ref": return makeFootnotePlaceholder(n.id);
      case "image": return makeImagePlaceholder(n.url, n.alt, n.widthPt, n.heightPt);
      default: return "";
    }
  }).join("");
}

// placeholder factories keep reference for richElements list
const _richElements: RichElement[] = [];

function makeImagePlaceholder(url: string, alt?: string, widthPt?: number, heightPt?: number): string {
  const ph = makePlaceholder("IMG");
  _richElements.push({ type: "image", placeholder: ph, url, widthPt, heightPt });
  return ph;
}

function makeMentionPlaceholder(name: string, email: string): string {
  const ph = makePlaceholder("MNT");
  _richElements.push({ type: "mention", placeholder: ph, name, email });
  return ph;
}

function makeFootnotePlaceholder(id: string): string {
  const ph = makePlaceholder("FNT");
  // content will be filled from footnote_def nodes later
  _richElements.push({ type: "footnote", placeholder: ph, name: id }); // name stores id temporarily
  return ph;
}

function makeTocPlaceholder(): string {
  const ph = makePlaceholder("TOC");
  _richElements.push({ type: "toc", placeholder: ph });
  return ph;
}

// ── Inline style requests ─────────────────────────────────────────────────────

interface TextRange { startIndex: number; endIndex: number; tabId?: string }

function buildInlineStyleRequests(nodes: InlineNode[], baseIndex: number, tabId?: string): { requests: object[]; length: number } {
  const requests: object[] = [];

  function walk(ns: InlineNode[], offset: number): number {
    let pos = offset;
    for (const n of ns) {
      switch (n.type) {
        case "text": pos += n.content.length; break;
        case "bold": {
          const start = pos;
          pos = walk(n.children, pos);
          requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { bold: true }));
          break;
        }
        case "italic": {
          const start = pos;
          pos = walk(n.children, pos);
          requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { italic: true }));
          break;
        }
        case "strikethrough": {
          const start = pos;
          pos = walk(n.children, pos);
          requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { strikethrough: true }));
          break;
        }
        case "underline": {
          const start = pos;
          pos = walk(n.children, pos);
          requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { underline: true }));
          break;
        }
        case "code": {
          const start = pos;
          pos += n.content.length;
          requests.push(makeTextStyleReq(
            { startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId },
            {
              weightedFontFamily: { fontFamily: "Roboto Mono" },
              fontSize: { magnitude: 10, unit: "PT" },
              backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
            }
          ));
          break;
        }
        case "link": {
          const start = pos;
          pos = walk(n.children, pos);
          requests.push(makeTextStyleReq(
            { startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId },
            { link: { url: n.url }, foregroundColor: { color: { rgbColor: { red: 0.07, green: 0.36, blue: 0.8 } } }, underline: true }
          ));
          break;
        }
        case "mention": pos += makeImagePlaceholder("", "").length; break; // already counted via inlinesToText
        case "footnote_ref": pos += makeFootnotePlaceholder("").length; break;
        case "image": pos += makeImagePlaceholder("", "").length; break;
        default: break;
      }
    }
    return pos;
  }

  // We re-walk to compute lengths correctly — placeholder lengths vary
  // Simpler: compute actual text from inlinesToText, then apply styles via character scanning
  const plainText = inlinesToTextForLength(nodes);
  walkForStyles(nodes, 0, baseIndex, tabId, requests);

  return { requests, length: plainText.length };
}

/** Compute plain text length without side effects */
function inlinesToTextForLength(nodes: InlineNode[]): string {
  return nodes.map(n => {
    switch (n.type) {
      case "text": return n.content;
      case "bold": case "italic": case "strikethrough": case "underline":
        return inlinesToTextForLength(n.children);
      case "code": return n.content;
      case "link": return inlinesToTextForLength(n.children);
      case "mention": return `\u27E8MNT:xx\u27E9`; // fixed placeholder length for estimation
      case "footnote_ref": return `\u27E8FNT:xx\u27E9`;
      case "image": return `\u27E8IMG:xx\u27E9`;
      default: return "";
    }
  }).join("");
}

function walkForStyles(nodes: InlineNode[], relOffset: number, baseIndex: number, tabId: string | undefined, requests: object[]): number {
  let pos = relOffset;
  for (const n of nodes) {
    switch (n.type) {
      case "text": pos += n.content.length; break;
      case "bold": {
        const start = pos;
        pos = walkForStyles(n.children, pos, baseIndex, tabId, requests);
        if (pos > start) requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { bold: true }));
        break;
      }
      case "italic": {
        const start = pos;
        pos = walkForStyles(n.children, pos, baseIndex, tabId, requests);
        if (pos > start) requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { italic: true }));
        break;
      }
      case "strikethrough": {
        const start = pos;
        pos = walkForStyles(n.children, pos, baseIndex, tabId, requests);
        if (pos > start) requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { strikethrough: true }));
        break;
      }
      case "underline": {
        const start = pos;
        pos = walkForStyles(n.children, pos, baseIndex, tabId, requests);
        if (pos > start) requests.push(makeTextStyleReq({ startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId }, { underline: true }));
        break;
      }
      case "code": {
        const start = pos;
        pos += n.content.length;
        requests.push(makeTextStyleReq(
          { startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId },
          {
            weightedFontFamily: { fontFamily: "Roboto Mono" },
            fontSize: { magnitude: 10, unit: "PT" },
            backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
          }
        ));
        break;
      }
      case "link": {
        const start = pos;
        pos = walkForStyles(n.children, pos, baseIndex, tabId, requests);
        if (pos > start) requests.push(makeTextStyleReq(
          { startIndex: baseIndex + start, endIndex: baseIndex + pos, tabId },
          { link: { url: n.url }, foregroundColor: { color: { rgbColor: { red: 0.07, green: 0.36, blue: 0.8 } } }, underline: true }
        ));
        break;
      }
      case "mention": pos += 8; break; // ⟨MNT:xx⟩ approx placeholder length
      case "footnote_ref": pos += 8; break;
      case "image": pos += 8; break;
      default: break;
    }
  }
  return pos;
}

function makeTextStyleReq(range: TextRange, style: Record<string, unknown>): object {
  const r: Record<string, unknown> = { startIndex: range.startIndex, endIndex: range.endIndex };
  if (range.tabId) r.tabId = range.tabId;
  return {
    updateTextStyle: {
      range: r,
      textStyle: style,
      fields: Object.keys(style).join(","),
    },
  };
}

// ── Build execution plan ──────────────────────────────────────────────────────

export function buildExecutionPlan(
  nodes: DocNode[],
  opts: {
    theme?: string;
    fontPair?: string;
    startIndex?: number;
    tabId?: string;
  } = {}
): ExecutionPlan {
  // Reset rich elements for this build
  _richElements.length = 0;
  _placeholderCounter = 0;

  const startIndex = opts.startIndex ?? 1;
  const tabId = opts.tabId;

  // ── Step 1: Collect all footnote defs
  const footnoteDefs = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === "footnote_def") {
      footnoteDefs.set(node.id, node.content);
    }
  }

  // ── Step 2: Build segments (text content + metadata)
  interface Segment {
    text: string;
    styleRequests: object[];
    paragraphStyleRequest?: object;
    bulletRequest?: object;
  }

  const segments: Segment[] = [];

  for (const node of nodes) {
    if (node.type === "footnote_def") continue; // already processed

    switch (node.type) {
      case "heading": {
        const styleMap: Record<number, string> = { 1: "HEADING_1", 2: "HEADING_2", 3: "HEADING_3", 4: "HEADING_4", 5: "HEADING_5", 6: "HEADING_6" };
        const text = inlinesToText(node.children) + "\n";
        segments.push({
          text,
          styleRequests: [], // inline styles will be added after
          paragraphStyleRequest: {
            updateParagraphStyle: {
              range: { startIndex: 0, endIndex: 1, ...(tabId ? { tabId } : {}) }, // placeholder, will fix
              paragraphStyle: { namedStyleType: styleMap[node.level] },
              fields: "namedStyleType",
            },
          },
        });
        break;
      }

      case "paragraph": {
        const text = inlinesToText(node.children) + "\n";
        segments.push({ text, styleRequests: [] });
        break;
      }

      case "blockquote": {
        const text = inlinesToText(node.children) + "\n";
        segments.push({
          text,
          styleRequests: [],
          paragraphStyleRequest: {
            updateParagraphStyle: {
              range: { startIndex: 0, endIndex: 1, ...(tabId ? { tabId } : {}) },
              paragraphStyle: {
                indentStart: { magnitude: 36, unit: "PT" },
                indentFirstLine: { magnitude: 0, unit: "PT" },
              },
              fields: "indentStart,indentFirstLine",
            },
          },
        });
        break;
      }

      case "code_block": {
        const text = node.content + "\n";
        segments.push({
          text,
          styleRequests: [],
          paragraphStyleRequest: {
            updateParagraphStyle: {
              range: { startIndex: 0, endIndex: 1, ...(tabId ? { tabId } : {}) },
              paragraphStyle: {
                indentStart: { magnitude: 18, unit: "PT" },
              },
              fields: "indentStart",
            },
          },
        });
        break;
      }

      case "bullet_list": {
        const listLines = flattenListItems(node.items, node.listType);
        const bulletPreset = node.listType === "numbered" ? "NUMBERED_DECIMAL_ALPHA_ROMAN" :
          node.listType === "checkbox" ? "BULLET_CHECKBOX" : "BULLET_DISC_CIRCLE_SQUARE";
        const text = listLines.texts.join("");
        segments.push({
          text,
          styleRequests: [],
          bulletRequest: {
            createParagraphBullets: {
              range: { startIndex: 0, endIndex: 1, ...(tabId ? { tabId } : {}) },
              bulletPreset,
            },
          },
        });
        break;
      }

      case "table": {
        const { headers, rows } = node.data;
        const nRows = rows.length + 1; // +1 for header
        const nCols = headers.length || 1;
        segments.push({
          text: "\n", // placeholder newline before table
          styleRequests: [],
          paragraphStyleRequest: {
            __tableInsert: { nRows, nCols, headers, dataRows: rows },
          } as any,
        });
        break;
      }

      case "horizontal_rule": {
        segments.push({
          text: "\n",
          styleRequests: [],
          paragraphStyleRequest: { __horizontalRule: true } as any,
        });
        break;
      }

      case "page_break": {
        segments.push({
          text: "\n",
          styleRequests: [],
          paragraphStyleRequest: { __pageBreak: true } as any,
        });
        break;
      }

      case "toc": {
        const ph = makeTocPlaceholder();
        segments.push({ text: ph + "\n", styleRequests: [] });
        break;
      }

      case "image": {
        const ph = makeImagePlaceholder(node.url, node.alt, node.widthPt, node.heightPt);
        segments.push({ text: ph + "\n", styleRequests: [] });
        break;
      }
    }
  }

  // ── Step 3: Build batchUpdate requests in REVERSE order ──────────────────
  // Insert from end to start so indices don't shift

  const pass1Requests: object[] = [];
  let currentIndex = startIndex;

  // Calculate total text to build indices
  const indexedSegments: Array<{ segment: Segment; insertIndex: number }> = [];
  let runningIndex = startIndex;
  for (const seg of segments) {
    indexedSegments.push({ segment: seg, insertIndex: runningIndex });
    runningIndex += seg.text.length;
  }

  // Reverse iterate
  for (let s = indexedSegments.length - 1; s >= 0; s--) {
    const { segment: seg, insertIndex } = indexedSegments[s];
    const psr = seg.paragraphStyleRequest as any;

    if (psr?.__horizontalRule) {
      pass1Requests.push({
        insertHorizontalRule: { location: { index: insertIndex, ...(tabId ? { tabId } : {}) } },
      });
      continue;
    }

    if (psr?.__pageBreak) {
      pass1Requests.push({
        insertPageBreak: { location: { index: insertIndex, ...(tabId ? { tabId } : {}) } },
      });
      continue;
    }

    if (psr?.__tableInsert) {
      const { nRows, nCols, headers: hdrs, dataRows } = psr.__tableInsert;
      pass1Requests.push({
        insertTable: {
          rows: nRows,
          columns: nCols,
          location: { index: insertIndex, ...(tabId ? { tabId } : {}) },
        },
      });
      // Table cells are filled in pass 2 (need re-read for actual indices)
      _richElements.push({
        type: "rich_link", // reuse type as table-fill marker
        placeholder: `\u27E8TBL:${s}\u27E9`,
        url: JSON.stringify({ headers: hdrs, rows: dataRows, segIdx: s }),
      });
      continue;
    }

    // Normal text insertion
    pass1Requests.push({
      insertText: {
        location: { index: insertIndex, ...(tabId ? { tabId } : {}) },
        text: seg.text,
      },
    });

    // Paragraph style (heading, blockquote, code indent)
    if (psr && !psr.__tableInsert && !psr.__horizontalRule && !psr.__pageBreak) {
      const reqCopy = JSON.parse(JSON.stringify(psr));
      if (reqCopy.updateParagraphStyle?.range) {
        reqCopy.updateParagraphStyle.range.startIndex = insertIndex;
        reqCopy.updateParagraphStyle.range.endIndex = insertIndex + seg.text.length;
        if (tabId) reqCopy.updateParagraphStyle.range.tabId = tabId;
        pass1Requests.push(reqCopy);
      }
    }

    // Bullet request
    if (seg.bulletRequest) {
      const br = JSON.parse(JSON.stringify(seg.bulletRequest)) as any;
      if (br.createParagraphBullets?.range) {
        br.createParagraphBullets.range.startIndex = insertIndex;
        br.createParagraphBullets.range.endIndex = insertIndex + seg.text.length - 1;
        if (tabId) br.createParagraphBullets.range.tabId = tabId;
        pass1Requests.push(br);
      }
    }

    // Inline style requests (bold, italic, etc.)
    // Re-run walkForStyles with actual base index
    const styleReqs: object[] = [];
    if (isNodeWithInlines(nodes, s)) {
      const nodeAtS = getContentNode(nodes, s);
      if (nodeAtS) {
        const inlineNodes = getInlineNodes(nodeAtS);
        if (inlineNodes.length > 0) {
          walkForStyles(inlineNodes, 0, insertIndex, tabId, styleReqs);
        }
      }
    }
    pass1Requests.push(...styleReqs);

    // Code block: apply monospace to full range
    const nodeAtS2 = getContentNode(nodes, s);
    if (nodeAtS2?.type === "code_block") {
      pass1Requests.push(makeTextStyleReq(
        { startIndex: insertIndex, endIndex: insertIndex + seg.text.length, tabId },
        {
          weightedFontFamily: { fontFamily: "Roboto Mono" },
          fontSize: { magnitude: 10, unit: "PT" },
          backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
        }
      ));
    }

    // Blockquote: apply italic + muted color to full text
    if (nodeAtS2?.type === "blockquote") {
      pass1Requests.push(makeTextStyleReq(
        { startIndex: insertIndex, endIndex: insertIndex + seg.text.length - 1, tabId },
        { italic: true, foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } } }
      ));
    }
  }

  // ── Step 4: Fill footnote content into richElements
  for (const el of _richElements) {
    if (el.type === "footnote" && el.name) {
      el.footnoteContent = footnoteDefs.get(el.name) ?? "";
    }
  }

  // ── Step 5: Theme requests
  const themeRequests = buildThemeRequests(opts.theme ?? "corporate", opts.fontPair ?? "arial_roboto");

  // ── Stats
  const stats = {
    sections: nodes.filter(n => n.type === "heading").length,
    tables: nodes.filter(n => n.type === "table").length,
    images: _richElements.filter(e => e.type === "image").length,
    mentions: _richElements.filter(e => e.type === "mention").length,
    footnotes: _richElements.filter(e => e.type === "footnote").length,
    hasToc: nodes.some(n => n.type === "toc"),
  };

  return {
    pass1Requests,
    richElements: [..._richElements],
    themeRequests,
    stats,
  };
}

// ── Helpers for node traversal ───────────────────────────────────────────────

function getContentNode(nodes: DocNode[], segIdx: number): DocNode | undefined {
  // segIdx maps to content nodes (excluding footnote_def)
  let ci = 0;
  for (const n of nodes) {
    if (n.type === "footnote_def") continue;
    if (ci === segIdx) return n;
    ci++;
  }
  return undefined;
}

function isNodeWithInlines(_nodes: DocNode[], _segIdx: number): boolean {
  return true; // we check inside getInlineNodes
}

function getInlineNodes(node: DocNode): InlineNode[] {
  switch (node.type) {
    case "heading": return node.children;
    case "paragraph": return node.children;
    case "blockquote": return node.children;
    default: return [];
  }
}

function flattenListItems(items: ListItem[], listType: string): { texts: string[] } {
  const texts: string[] = [];
  for (const item of items) {
    texts.push(inlinesToText(item.children) + "\n");
    if (item.subItems?.length) {
      const sub = flattenListItems(item.subItems, listType);
      texts.push(...sub.texts);
    }
  }
  return { texts };
}

// ── Theme requests ────────────────────────────────────────────────────────────

function buildThemeRequests(themeName: string, fontPairName: string): object[] {
  const colors = getTheme(themeName as any);
  const fonts = getFontPair(fontPairName as any);
  const tok = deriveDocTokens(colors, fonts);

  function ns(
    styleType: string,
    colorHex: string,
    sizePt: number,
    bold: boolean,
    font: string,
    abovePt: number,
    belowPt: number,
    lineSpacing?: number
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
