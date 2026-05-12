/**
 * docs-engine/executor.ts
 * Executes the 3-pass plan against Google Docs API
 */

import { docsRequest, googleFetch } from "../google";
import type { ExecutionPlan, RichElement } from "./types";

// ── Pass 1: Text + structure ──────────────────────────────────────────────────

export async function executePass1(
  accessToken: string,
  documentId: string,
  plan: ExecutionPlan,
  tabId?: string
): Promise<void> {
  if (!plan.pass1Requests.length) return;
  await docsRequest(accessToken, documentId, "POST", ":batchUpdate", { requests: plan.pass1Requests });
}

// ── Pass 2: Rich elements (images, mentions, footnotes, TOC) ─────────────────

export async function executePass2(
  accessToken: string,
  documentId: string,
  richElements: RichElement[],
  tabId?: string
): Promise<{ warnings: string[] }> {
  if (!richElements.length) return { warnings: [] };

  const warnings: string[] = [];

  // Separate tables (no placeholder) from inline rich elements
  const tableElements = richElements.filter(el => el.type === "rich_link" && el.url?.startsWith("{"));
  const inlineElements = richElements.filter(el => !(el.type === "rich_link" && el.url?.startsWith("{")));

  // Fill tables (no placeholder search needed)
  for (const el of tableElements) {
    try {
      const tableData = JSON.parse(el.url!);
      await fillTableCells(accessToken, documentId, tableData, tabId);
    } catch (err: any) {
      warnings.push(`Failed to fill table: ${err.message}`);
    }
  }

  if (!inlineElements.length) return { warnings };

  // Re-read document to find inline element placeholders
  const path = tabId ? "?includeTabsContent=true" : "";
  const doc = await docsRequest(accessToken, documentId, "GET", path) as any;

  let bodyContent: any[];
  if (tabId && doc.tabs) {
    const tab = findTab(doc.tabs, tabId);
    bodyContent = tab?.documentTab?.body?.content ?? [];
  } else {
    bodyContent = doc.body?.content ?? [];
  }

  const docText = buildDocText(bodyContent);

  const located: Array<{ el: RichElement; idx: number }> = [];
  for (const el of inlineElements) {
    const idx = findPlaceholderDocIndex(docText, el.placeholder);
    if (idx === null) {
      warnings.push(`Placeholder not found: ${el.placeholder} (${el.type})`);
      continue;
    }
    located.push({ el, idx });
  }

  // Sort descending by index
  located.sort((a, b) => b.idx - a.idx);

  for (const { el, idx } of located) {
    try {
      await insertRichElement(accessToken, documentId, el, idx, tabId, warnings);
    } catch (err: any) {
      warnings.push(`Failed to insert ${el.type}: ${err.message}`);
    }
  }

  return { warnings };
}

async function insertRichElement(
  accessToken: string,
  documentId: string,
  el: RichElement,
  idx: number,
  tabId: string | undefined,
  warnings: string[]
): Promise<void> {
  const loc = tabId ? { index: idx, tabId } : { index: idx };
  const endLoc = tabId
    ? { startIndex: idx, endIndex: idx + el.placeholder.length, tabId }
    : { startIndex: idx, endIndex: idx + el.placeholder.length };

  // Delete placeholder first
  const deleteReq = { deleteContentRange: { range: endLoc } };

  switch (el.type) {
    case "image": {
      if (!el.url) { warnings.push("Image missing URL"); return; }
      // Check if URL is reachable (skip invalid URLs gracefully)
      const insertReq: Record<string, unknown> = {
        insertInlineImage: {
          location: loc,
          uri: el.url,
          objectSize: el.widthPt ? {
            width: { magnitude: el.widthPt, unit: "PT" },
            height: { magnitude: el.heightPt ?? el.widthPt * 0.6, unit: "PT" },
          } : {
            // Default: max 468pt wide (6.5 inch page width)
            width: { magnitude: 468, unit: "PT" },
          },
        },
      };
      const body: Record<string, unknown> = { requests: [deleteReq, insertReq] };
      await docsRequest(accessToken, documentId, "POST", ":batchUpdate", body);
      break;
    }

    case "mention": {
      if (!el.email) { warnings.push("Mention missing email"); return; }
      const personProps: Record<string, unknown> = { email: el.email };
      if (el.name) personProps.name = el.name;
      const chipReqs: object[] = [
        deleteReq,
        { insertPerson: { personProperties: personProps, location: loc } },
      ];
      await docsRequest(accessToken, documentId, "POST", ":batchUpdate", { requests: chipReqs });
      break;
    }

    case "footnote": {
      const body: Record<string, unknown> = { requests: [deleteReq, { createFootnote: { location: loc } }] };
      const result = await docsRequest(accessToken, documentId, "POST", ":batchUpdate", body) as any;
      const fnId = result.replies?.find((r: any) => r.createFootnote)?.createFootnote?.footnoteId;
      if (fnId && el.footnoteContent) {
        await docsRequest(accessToken, documentId, "POST", ":batchUpdate", {
          requests: [{ insertText: { location: { segmentId: fnId, index: 0 }, text: el.footnoteContent } }],
        });
      }
      break;
    }

    case "toc": {
      const body: Record<string, unknown> = {
        requests: [
          deleteReq,
          { insertTableOfContents: { location: loc } },
        ],
      };
      await docsRequest(accessToken, documentId, "POST", ":batchUpdate", body);
      break;
    }

    case "rich_link": {
      // Used for table-fill: el.url contains JSON { headers, rows, segIdx }
      if (!el.url) break;
      try {
        const tableData = JSON.parse(el.url);
        await fillTableCells(accessToken, documentId, tableData, tabId);
      } catch (_) {
        // Not a table-fill marker, treat as regular rich link
      }
      break;
    }
  }
}

// ── Pass 3: Theme ─────────────────────────────────────────────────────────────

export async function executePass3(
  accessToken: string,
  documentId: string,
  plan: ExecutionPlan
): Promise<void> {
  if (!plan.themeRequests.length) return;
  await docsRequest(accessToken, documentId, "POST", ":batchUpdate", {
    requests: plan.themeRequests,
  });
}

// ── Header / Footer ───────────────────────────────────────────────────────────

export async function applyHeaderFooter(
  accessToken: string,
  documentId: string,
  headerText?: string,
  footerText?: string
): Promise<void> {
  const doc = await docsRequest(accessToken, documentId) as any;
  const requests: object[] = [];

  async function upsertSegment(type: "header" | "footer", text: string) {
    const idKey = type === "header" ? "defaultHeaderId" : "defaultFooterId";
    const segId = doc.documentStyle?.[idKey];
    if (!segId) {
      // Create header/footer
      const createKey = type === "header" ? "createHeader" : "createFooter";
      const result = await docsRequest(accessToken, documentId, "POST", ":batchUpdate", {
        requests: [{ [createKey]: { type: "DEFAULT" } }],
      }) as any;
      const newId = result.replies?.[0]?.[createKey]?.[type === "header" ? "headerId" : "footerId"];
      if (newId) {
        await docsRequest(accessToken, documentId, "POST", ":batchUpdate", {
          requests: [{ insertText: { location: { segmentId: newId, index: 0 }, text } }],
        });
      }
    } else {
      // Clear and set
      const segDoc = await docsRequest(accessToken, `${documentId}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`) as any;
      const seg = type === "header" ? segDoc.headers?.[segId] : segDoc.footers?.[segId];
      const endIdx = seg?.content?.slice(-1)[0]?.endIndex ?? 1;
      const reqs: object[] = [];
      if (endIdx > 1) reqs.push({ deleteContentRange: { range: { segmentId: segId, startIndex: 0, endIndex: endIdx - 1 } } });
      reqs.push({ insertText: { location: { segmentId: segId, index: 0 }, text } });
      await docsRequest(accessToken, documentId, "POST", ":batchUpdate", { requests: reqs });
    }
  }

  if (headerText) await upsertSegment("header", headerText);
  if (footerText) await upsertSegment("footer", footerText);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findTab(tabList: any[], tabId: string): any | null {
  for (const tab of tabList ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const found = findTab(tab.childTabs ?? [], tabId);
    if (found) return found;
  }
  return null;
}

/**
 * Build a searchable text string from doc body content.
 * Returns text + parallel docIndices array for accurate placeholder→docIndex mapping.
 */
interface DocTextResult {
  text: string;
  docIndices: number[]; // parallel array: docIndices[i] = Google Doc index for text[i]
}

function buildDocText(bodyContent: any[]): DocTextResult {
  const chars: string[] = [];
  const docIndices: number[] = [];

  function walkContent(content: any[]) {
    for (const elem of content ?? []) {
      if (elem.paragraph) {
        for (const pe of elem.paragraph.elements ?? []) {
          if (pe.textRun?.content && pe.startIndex !== undefined) {
            const t = pe.textRun.content as string;
            for (let ci = 0; ci < t.length; ci++) {
              chars.push(t[ci]);
              docIndices.push(pe.startIndex + ci);
            }
          }
        }
      } else if (elem.table) {
        for (const row of elem.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) {
            walkContent(cell.content ?? []);
          }
        }
      }
    }
  }

  walkContent(bodyContent);
  return { text: chars.join(""), docIndices };
}

/**
 * Find placeholder in doc text and return the actual Google Doc start index.
 */
function findPlaceholderDocIndex(docText: DocTextResult, placeholder: string): number | null {
  const pos = docText.text.indexOf(placeholder);
  if (pos === -1) return null;
  return docText.docIndices[pos] ?? (1 + pos); // fallback to offset+pos
}

async function fillTableCells(
  accessToken: string,
  documentId: string,
  tableData: { headers: string[]; rows: string[][] },
  tabId?: string
): Promise<void> {
  const path = tabId ? "?includeTabsContent=true" : "";
  const doc = await docsRequest(accessToken, documentId, "GET", path) as any;
  const bodyContent = tabId
    ? findTab(doc.tabs, tabId)?.documentTab?.body?.content
    : doc.body?.content;

  const { headers, rows } = tableData;
  const nRows = rows.length + 1;
  const nCols = headers.length;

  // Find the most recently inserted table matching dimensions (findLast not in older V8)
  const tables = (bodyContent ?? []).filter((e: any) => e.table);
  let tableElem: any = null;
  for (let ti = tables.length - 1; ti >= 0; ti--) {
    if (tables[ti].table.rows === nRows && tables[ti].table.columns === nCols) {
      tableElem = tables[ti];
      break;
    }
  }
  if (!tableElem) return;

  const allData = [headers, ...rows];
  const insertReqs: object[] = [];
  for (let r = 0; r < allData.length; r++) {
    for (let c = 0; c < nCols; c++) {
      const cell = tableElem.table.tableRows[r]?.tableCells[c];
      const cellIndex = cell?.content?.[0]?.startIndex;
      const cellText = allData[r][c] ?? "";
      if (cellIndex !== undefined && cellText) {
        const loc = tabId ? { index: cellIndex, tabId } : { index: cellIndex };
        insertReqs.push({ insertText: { location: loc, text: cellText } });
      }
    }
  }

  if (!insertReqs.length) return;

  // Insert in reverse order
  const body: Record<string, unknown> = { requests: insertReqs.reverse() };
  await docsRequest(accessToken, documentId, "POST", ":batchUpdate", body);

  // Style header row (bold + theme color)
  const headerRow = tableElem.table.tableRows[0];
  if (headerRow) {
    const styleReqs: object[] = [];
    for (const cell of headerRow.tableCells ?? []) {
      const cellStart = cell.content?.[0]?.startIndex;
      const cellEnd = cell.content?.slice(-1)[0]?.endIndex;
      if (cellStart !== undefined && cellEnd !== undefined) {
        const range = tabId ? { startIndex: cellStart, endIndex: cellEnd, tabId } : { startIndex: cellStart, endIndex: cellEnd };
        styleReqs.push({
          updateTextStyle: {
            range,
            textStyle: { bold: true, foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
            fields: "bold,foregroundColor",
          },
        });
        styleReqs.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: { tableStartLocation: { index: tableElem.startIndex }, rowIndex: 0, columnIndex: 0 },
              rowSpan: 1, columnSpan: nCols,
            },
            tableCellStyle: { backgroundColor: { color: { rgbColor: { red: 0.24, green: 0.47, blue: 0.78 } } } },
            fields: "backgroundColor",
          },
        });
      }
    }
    if (styleReqs.length) {
      const sb: Record<string, unknown> = { requests: styleReqs };
      try {
        await docsRequest(accessToken, documentId, "POST", ":batchUpdate", sb);
      } catch (_) { /* table style not critical */ }
    }
  }
}
