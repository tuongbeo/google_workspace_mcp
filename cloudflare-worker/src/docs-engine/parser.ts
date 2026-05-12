/**
 * docs-engine/parser.ts
 * Markdown → AST using markdown-it + custom syntax extensions
 *
 * Custom extensions:
 *   @[Name](email)     → mention chip
 *   [^id]              → footnote reference
 *   [^id]: text        → footnote definition
 *   \pagebreak         → page break
 *   \toc               → table of contents
 *   - [ ] / - [x]      → checkbox list items (standard markdown-it-task-lists style)
 */

import MarkdownIt from "markdown-it";
import type { DocNode, InlineNode, ListItem, TableData } from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

const MENTION_RE = /@\[([^\]]+)\]\(([^)@\s]+@[^)]+)\)/g;
const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;
const IMAGE_SIZE_RE = /^(.*?)\s*=(\d+)x(\d+)$/; // ![alt =200x150](url)

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

// ── Inline parser ────────────────────────────────────────────────────────────

function parseInlineText(raw: string): InlineNode[] {
  // We parse inline by walking markdown-it tokens on a mini doc
  const tokens = md.parseInline(raw, {})[0]?.children || [];
  return tokensToInline(tokens);
}

function tokensToInline(tokens: any[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "text" || t.type === "softbreak" || t.type === "hardbreak") {
      const content = t.type === "text" ? t.content : "\n";
      nodes.push(...expandInlineText(content));
      i++;
    } else if (t.type === "strong_open") {
      const children: any[] = [];
      i++;
      while (i < tokens.length && tokens[i].type !== "strong_close") {
        children.push(tokens[i]);
        i++;
      }
      nodes.push({ type: "bold", children: tokensToInline(children) });
      i++; // skip strong_close
    } else if (t.type === "em_open") {
      const children: any[] = [];
      i++;
      while (i < tokens.length && tokens[i].type !== "em_close") {
        children.push(tokens[i]);
        i++;
      }
      nodes.push({ type: "italic", children: tokensToInline(children) });
      i++;
    } else if (t.type === "s_open" || t.type === "del_open") {
      const children: any[] = [];
      i++;
      while (i < tokens.length && tokens[i].type !== "s_close" && tokens[i].type !== "del_close") {
        children.push(tokens[i]);
        i++;
      }
      nodes.push({ type: "strikethrough", children: tokensToInline(children) });
      i++;
    } else if (t.type === "code_inline") {
      nodes.push({ type: "code", content: t.content });
      i++;
    } else if (t.type === "link_open") {
      const href = t.attrGet("href") || "";
      const children: any[] = [];
      i++;
      while (i < tokens.length && tokens[i].type !== "link_close") {
        children.push(tokens[i]);
        i++;
      }
      nodes.push({ type: "link", url: href, children: tokensToInline(children) });
      i++;
    } else if (t.type === "image") {
      const src = t.attrGet("src") || "";
      let alt = t.content || "";
      let widthPt: number | undefined;
      let heightPt: number | undefined;
      const sizeMatch = IMAGE_SIZE_RE.exec(alt);
      if (sizeMatch) {
        alt = sizeMatch[1];
        widthPt = Number(sizeMatch[2]);
        heightPt = Number(sizeMatch[3]);
      }
      nodes.push({ type: "image", url: src, alt, widthPt, heightPt });
      i++;
    } else {
      i++;
    }
  }
  return nodes;
}

/**
 * Expand a raw text string to handle custom inline syntax:
 * @[Name](email) → mention
 * [^id] → footnote_ref
 */
function expandInlineText(raw: string): InlineNode[] {
  // Combined regex for mention and footnote_ref
  const COMBINED = /@\[([^\]]+)\]\(([^)@\s]+@[^)]+)\)|\[\^([^\]]+)\]/g;
  const nodes: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  COMBINED.lastIndex = 0;
  while ((m = COMBINED.exec(raw)) !== null) {
    if (m.index > last) nodes.push({ type: "text", content: raw.slice(last, m.index) });
    if (m[1] !== undefined) {
      // mention: @[Name](email)
      nodes.push({ type: "mention", name: m[1], email: m[2] });
    } else {
      // footnote ref: [^id]
      nodes.push({ type: "footnote_ref", id: m[3] });
    }
    last = m.index + m[0].length;
  }
  if (last < raw.length) nodes.push({ type: "text", content: raw.slice(last) });
  return nodes.length ? nodes : [{ type: "text", content: raw }];
}

// ── Block parser ─────────────────────────────────────────────────────────────

export function parseMarkdown(input: string): DocNode[] {
  // Pre-process custom syntax BEFORE feeding to markdown-it
  // Use unique sentinel strings that won't appear in normal text
  // and will survive as standalone paragraph tokens
  const processed = input
    .replace(/\\pagebreak/g, "\n\n\u0002PAGEBREAK\u0003\n\n")
    .replace(/\\toc/g, "\n\n\u0002TOC\u0003\n\n");

  const tokens = md.parse(processed, {});
  const nodes: DocNode[] = [];
  let i = 0;

  // Collect footnote defs — strip them from the processed content
  // [^id]: text at start of line (may be parsed as paragraphs — we intercept below)
  const footnoteDefs: Map<string, string> = new Map();
  const FNDEF_RE = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
  let fn: RegExpExecArray | null;
  while ((fn = FNDEF_RE.exec(input)) !== null) {
    footnoteDefs.set(fn[1], fn[2].trim());
  }
  // Build set of footnote def strings to filter them out of paragraph nodes
  const footnoteDefLines = new Set<string>();
  for (const [id, content] of footnoteDefs) {
    footnoteDefLines.add(`[^${id}]: ${content}`);
  }

  while (i < tokens.length) {
    const t = tokens[i];

    // HTML comments used as sentinels (fallback if html: true)
    if (t.type === "html_block") {
      if (t.content.includes("PAGEBREAK")) nodes.push({ type: "page_break" });
      else if (t.content.includes("TOC")) nodes.push({ type: "toc" });
      i++;
      continue;
    }

    // Sentinel detection in inline tokens (the main path with html: false)
    if (t.type === "inline") {
      const c = t.content.trim();
      if (c === "\u0002PAGEBREAK\u0003") { nodes.push({ type: "page_break" }); i++; continue; }
      if (c === "\u0002TOC\u0003") { nodes.push({ type: "toc" }); i++; continue; }
    }

    // Headings
    if (t.type === "heading_open") {
      const level = parseInt(t.tag.replace("h", "")) as 1|2|3|4|5|6;
      const inlineToken = tokens[i + 1];
      const children = inlineToken ? parseInlineText(inlineToken.content) : [];
      nodes.push({ type: "heading", level, children });
      i += 3; // heading_open, inline, heading_close
      continue;
    }

    // Paragraphs
    if (t.type === "paragraph_open") {
      const inlineToken = tokens[i + 1];
      if (inlineToken) {
        const raw = inlineToken.content.trim();

        // Sentinel: \pagebreak and \toc
        if (raw === "\u0002PAGEBREAK\u0003") { nodes.push({ type: "page_break" }); i += 3; continue; }
        if (raw === "\u0002TOC\u0003") { nodes.push({ type: "toc" }); i += 3; continue; }

        // Skip footnote definition paragraphs
        if (/^\[\^[^\]]+\]:\s*.+/.test(raw)) { i += 3; continue; }

        // Standalone image
        const imgOnlyMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(raw);
        if (imgOnlyMatch) {
          let alt = imgOnlyMatch[1];
          const src = imgOnlyMatch[2];
          let widthPt: number | undefined;
          let heightPt: number | undefined;
          const sizeMatch = IMAGE_SIZE_RE.exec(alt);
          if (sizeMatch) { alt = sizeMatch[1]; widthPt = Number(sizeMatch[2]); heightPt = Number(sizeMatch[3]); }
          nodes.push({ type: "image", url: src, alt, widthPt, heightPt });
        } else {
          const children = parseInlineText(raw);
          nodes.push({ type: "paragraph", children });
        }
      }
      i += 3;
      continue;
    }

    // Bullet / ordered / task lists
    if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      const isOrdered = t.type === "ordered_list_open";
      const closeType = isOrdered ? "ordered_list_close" : "bullet_list_close";
      i++;
      const items: ListItem[] = [];
      let isCheckbox = false;

      while (i < tokens.length && tokens[i].type !== closeType) {
        if (tokens[i].type === "list_item_open") {
          i++;
          let checked: boolean | undefined = undefined;
          const itemInlines: InlineNode[] = [];
          const subItems: ListItem[] = [];

          while (i < tokens.length && tokens[i].type !== "list_item_close") {
            const cur = tokens[i];
            if (cur.type === "paragraph_open" || cur.type === "paragraph_close") { i++; continue; }
            if (cur.type === "inline") {
              let raw = cur.content;
              // Detect checkbox: "[ ] text" or "[x] text"
              const cbMatch = /^\[([ xX])\]\s*(.*)$/.exec(raw);
              if (cbMatch) {
                checked = cbMatch[1] !== " ";
                isCheckbox = true;
                raw = cbMatch[2];
              }
              itemInlines.push(...parseInlineText(raw));
            }
            // nested list — simplified: just collect text
            i++;
          }
          items.push({ children: itemInlines, checked, subItems: subItems.length ? subItems : undefined });
          i++; // skip list_item_close
        } else {
          i++;
        }
      }
      const listType = isCheckbox ? "checkbox" : (isOrdered ? "numbered" : "bullet");
      nodes.push({ type: "bullet_list", items, listType });
      i++; // skip list close
      continue;
    }

    // Code block (fenced or indented)
    if (t.type === "fence" || t.type === "code_block") {
      nodes.push({ type: "code_block", language: t.info?.trim() || undefined, content: t.content });
      i++;
      continue;
    }

    // Blockquote
    if (t.type === "blockquote_open") {
      i++;
      const allText: InlineNode[] = [];
      while (i < tokens.length && tokens[i].type !== "blockquote_close") {
        if (tokens[i].type === "inline") allText.push(...parseInlineText(tokens[i].content));
        i++;
      }
      nodes.push({ type: "blockquote", children: allText });
      i++;
      continue;
    }

    // Horizontal rule
    if (t.type === "hr") {
      nodes.push({ type: "horizontal_rule" });
      i++;
      continue;
    }

    // Table
    if (t.type === "table_open") {
      i++;
      const headers: string[] = [];
      const rows: string[][] = [];
      let inHead = false;
      let inBody = false;
      let currentRow: string[] = [];

      while (i < tokens.length && tokens[i].type !== "table_close") {
        const cur = tokens[i];
        if (cur.type === "thead_open") { inHead = true; inBody = false; }
        else if (cur.type === "thead_close") { inHead = false; }
        else if (cur.type === "tbody_open") { inBody = true; }
        else if (cur.type === "tr_open") { currentRow = []; }
        else if (cur.type === "tr_close") {
          if (inBody) rows.push(currentRow);
        }
        else if ((cur.type === "th" || cur.type === "td") && cur.children) {
          const cellText = (cur.children as any[]).map((c: any) => c.content || "").join("");
          if (inHead) headers.push(cellText);
          else currentRow.push(cellText);
        }
        i++;
      }
      nodes.push({ type: "table", data: { headers, rows } });
      i++; // skip table_close
      continue;
    }

    i++;
  }

  // Append footnote defs
  for (const [id, content] of footnoteDefs) {
    nodes.push({ type: "footnote_def", id, content });
  }

  return nodes;
}
