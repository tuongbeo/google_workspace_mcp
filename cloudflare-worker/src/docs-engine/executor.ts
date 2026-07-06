/**
 * docs-engine/executor.ts
 * Executes the 3-pass plan against Google Docs API
 */

import { docsRequest, googleFetch } from "../google";
import type { ExecutionPlan, RichElement } from "./types";
import { isSafeDocUrl } from "./builder";

// ── Pass 1: Text + structure ──────────────────────────────────────────────────

export async function executePass1(
  accessToken: string,
  documentId: string,
  plan: ExecutionPlan,
  tabId?: string
): Promise<void> {
  if (!plan.pass1Requests.length) return;
  await docsRequest(accessToken, documentId, ":batchUpdate", "POST", { requests: plan.pass1Requests });
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

  // All rich elements (images, mentions, footnotes, TOC, tables) use placeholders
  // Re-read document to find all placeholders at once
  const path = tabId ? "?includeTabsContent=true" : "";
  const doc = await docsRequest(accessToken, documentId, path) as any;

  let bodyContent: any[];
  if (tabId && doc.tabs) {
    const tab = findTab(doc.tabs, tabId);
    bodyContent = tab?.documentTab?.body?.content ?? [];
  } else {
    bodyContent = doc.body?.content ?? [];
  }

  const docText = buildDocText(bodyContent);

  const located: Array<{ el: RichElement; idx: number }> = [];
  for (const el of richElements) {
    const idx = findPlaceholderDocIndex(docText, el.placeholder);
    if (idx === null) {
      warnings.push(`Placeholder not found: ${el.placeholder} (${el.type})`);
      continue;
    }
    located.push({ el, idx });
  }

  // Process in descending order to avoid index drift
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
      if (!isSafeDocUrl(el.url)) { warnings.push(`Image URL rejected (unsupported scheme): ${el.url}`); return; }
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
      await docsRequest(accessToken, documentId, ":batchUpdate", "POST", body);
      break;
    }

    case "mention": {
      if (!el.email) { warnings.push("Mention missing email"); return; }
      const phEnd = idx + el.placeholder.length;
      const chipLoc = tabId ? { index: idx, tabId } : { index: idx };
      const deleteRange = tabId
        ? { startIndex: idx, endIndex: phEnd, tabId }
        : { startIndex: idx, endIndex: phEnd };
      try {
        // insertPerson is silently ignored when the target is inside a textRun
        // that was part of a previous insertText call.
        //
        // Fix: insert a temporary "\n" BEFORE the placeholder to create a fresh
        // paragraph boundary. insertPerson at the START of that fresh paragraph
        // (which is not inside any textRun) always succeeds.
        // Then clean up: merge paragraph back by deleting the "\n".
        //
        // Steps:
        //   1. Insert "\n" at idx → placeholder is now at idx+1
        //   2. insertPerson at idx+1 (start of new paragraph, clean boundary)
        //   3. Delete placeholder [idx+2, idx+2+phLen)
        //   4. Delete the "\n" at idx (merge paragraphs back)

        const insertNL = tabId
          ? { index: idx, tabId }
          : { index: idx };
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
          requests: [{ insertText: { location: insertNL, text: "\n" } }],
        });

        // After "\n" insert: placeholder shifted to idx+1, fresh para starts at idx+1
        const freshLoc = tabId ? { index: idx + 1, tabId } : { index: idx + 1 };
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
          requests: [{ insertPerson: { personProperties: { email: el.email }, location: freshLoc } }],
        });

        // Delete placeholder (now at idx+2 because chip took idx+1 and NL is at idx)
        const phShifted = tabId
          ? { startIndex: idx + 2, endIndex: idx + 2 + el.placeholder.length, tabId }
          : { startIndex: idx + 2, endIndex: idx + 2 + el.placeholder.length };
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
          requests: [{ deleteContentRange: { range: phShifted } }],
        });

        // Delete the "\n" at idx to merge chip back into original paragraph
        const nlRange = tabId
          ? { startIndex: idx, endIndex: idx + 1, tabId }
          : { startIndex: idx, endIndex: idx + 1 };
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
          requests: [{ deleteContentRange: { range: nlRange } }],
        });

      } catch (err: any) {
        // Fallback: replace placeholder with @displayName text
        const displayName = el.name || el.email;
        try {
          await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
            requests: [{ replaceAllText: {
              containsText: { text: el.placeholder, matchCase: true },
              replaceText: `@${displayName}`,
            }}],
          });
        } catch (_) {}
        warnings.push(`insertPerson failed for ${el.email}: ${err.message}`);
      }
      break;
    }

        case "footnote": {
      const body: Record<string, unknown> = { requests: [deleteReq, { createFootnote: { location: loc } }] };
      const result = await docsRequest(accessToken, documentId, ":batchUpdate", "POST", body) as any;
      const fnId = result.replies?.find((r: any) => r.createFootnote)?.createFootnote?.footnoteId;
      if (fnId && el.footnoteContent) {
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
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
      await docsRequest(accessToken, documentId, ":batchUpdate", "POST", body);
      break;
    }

    case "rich_link": {
      // Table: delete placeholder, insert table, fill cells
      if (!el.url) break;
      try {
        const tableData = JSON.parse(el.url) as {
          headers: string[]; rows: string[][];
          nRows: number; nCols: number;
        };
        if (!tableData.nCols || tableData.nCols < 1) {
          warnings.push(`Table has invalid nCols=${tableData.nCols}`);
          break;
        }
        // Delete placeholder + insert table at same location
        const plEnd = idx + el.placeholder.length;
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
          requests: [
            { deleteContentRange: { range: tabId ? { startIndex: idx, endIndex: plEnd, tabId } : { startIndex: idx, endIndex: plEnd } } },
            { insertTable: { rows: tableData.nRows, columns: tableData.nCols, location: { index: idx, ...(tabId ? { tabId } : {}) } } },
          ],
        });
        // Re-read and fill cells
        await fillTableCells(accessToken, documentId, tableData, tabId);
      } catch (err: any) {
        warnings.push(`Failed to insert table: ${err.message}`);
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
  await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
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
      const result = await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
        requests: [{ [createKey]: { type: "DEFAULT" } }],
      }) as any;
      const newId = result.replies?.[0]?.[createKey]?.[type === "header" ? "headerId" : "footerId"];
      if (newId) {
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", {
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
      await docsRequest(accessToken, documentId, ":batchUpdate", "POST", { requests: reqs });
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
  const doc = await docsRequest(accessToken, documentId, path) as any;
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
  await docsRequest(accessToken, documentId, ":batchUpdate", "POST", body);

  // Style header row: background + bold white text per cell
  const headerRow = tableElem.table.tableRows[0];
  if (headerRow) {
    const styleReqs: object[] = [];
    for (let ci = 0; ci < nCols; ci++) {
      const cell = headerRow.tableCells[ci];
      if (!cell) continue;
      const cellStart = cell.content?.[0]?.startIndex;
      const lastContent = cell.content?.slice(-1)[0];
      // endIndex of last element in cell (typically the trailing \n paragraph)
      // Use endIndex - 1 to stay within text content, not include paragraph end
      const cellEnd = lastContent?.endIndex;
      if (cellStart === undefined || cellEnd === undefined) continue;

      // Text style: bold + white — apply to all text in cell excluding trailing \n
      const textRange = tabId
        ? { startIndex: cellStart, endIndex: cellEnd - 1, tabId }
        : { startIndex: cellStart, endIndex: cellEnd - 1 };
      if (cellEnd - 1 > cellStart) {
        styleReqs.push({
          updateTextStyle: {
            range: textRange,
            textStyle: {
              bold: true,
              foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
              weightedFontFamily: { fontFamily: "Arial" },
            },
            fields: "bold,foregroundColor,weightedFontFamily",
          },
        });
      }

      // Cell background: blue per cell (not columnSpan — apply individually)
      styleReqs.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { index: tableElem.startIndex },
              rowIndex: 0,
              columnIndex: ci,
            },
            rowSpan: 1,
            columnSpan: 1,
          },
          tableCellStyle: {
            backgroundColor: { color: { rgbColor: { red: 0.24, green: 0.47, blue: 0.78 } } },
            paddingTop: { magnitude: 4, unit: "PT" },
            paddingBottom: { magnitude: 4, unit: "PT" },
            paddingLeft: { magnitude: 6, unit: "PT" },
            paddingRight: { magnitude: 6, unit: "PT" },
          },
          fields: "backgroundColor,paddingTop,paddingBottom,paddingLeft,paddingRight",
        },
      });
    }

    // Set table to use full page width with even column distribution
    styleReqs.push({
      updateTableColumnProperties: {
        tableStartLocation: { index: tableElem.startIndex },
        columnIndices: Array.from({ length: nCols }, (_, i) => i),
        tableColumnProperties: {
          widthType: "EVENLY_DISTRIBUTED",
        },
        fields: "widthType",
      },
    });

    if (styleReqs.length) {
      try {
        await docsRequest(accessToken, documentId, ":batchUpdate", "POST", { requests: styleReqs });
      } catch (e: any) {
        // Table style non-critical
      }
    }
  }
}
