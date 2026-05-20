/**
 * sheets-engine/executor.ts
 * 4-pass engine for write_google_sheet
 */

import { googleFetch, sheetsRequest } from "../google";
import { THEMES, FONT_PAIRS, deriveSheetTokens, hexToSheetsRgb } from "../styles";
import { parseInput, buildNumberFormat } from "./parser";
import { buildPersonChipCell, buildFileChipCell, isEmail, isDriveUrl } from "./chipRuns";
import {
  WriteSheetInput, SheetData, ParsedSheet, ParsedColumn,
  ColumnConfig, ColumnType, ChartConfig, ThemeName,
} from "./types";

function rgb(hex: string) { return hexToSheetsRgb(hex); }
function gr(sid: number, r0: number, r1: number, c0: number, c1: number) {
  return { sheetId: sid, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 };
}
function colLetter(n: number): string {
  return n < 26 ? String.fromCharCode(65 + n)
    : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
}
function parseAnchor(cell: string): { rowIndex: number; columnIndex: number } {
  const m = cell.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return { rowIndex: 0, columnIndex: 0 };
  const col = m[1].toUpperCase().split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return { rowIndex: parseInt(m[2]) - 1, columnIndex: col };
}
function parseA1Range(a1: string, sheetId: number) {
  const p = a1.includes("!") ? a1.split("!")[1] : a1;
  const m = p.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return gr(sheetId, 0, 0, 0, 0);
  const ci = (c: string) => c.toUpperCase().split("").reduce((a, x) => a * 26 + x.charCodeAt(0) - 64, 0) - 1;
  return { sheetId, startRowIndex: parseInt(m[2]) - 1, endRowIndex: parseInt(m[4]),
    startColumnIndex: ci(m[1]), endColumnIndex: ci(m[3]) + 1 };
}
const STATUS_COLORS: Record<string, string> = {
  green: "#d1fae5", amber: "#fef3c7", red: "#fee2e2", blue: "#dbeafe", gray: "#f3f4f6",
};
async function bu(at: string, sid: string, reqs: unknown[]) {
  return sheetsRequest(at, sid, ":batchUpdate", "POST", { requests: reqs });
}

// ── PASS 2 ───────────────────────────────────────────────────────────────────

async function pass2(
  at: string, spreadsheetId: string, sheetId: number, sheetName: string,
  parsed: ParsedSheet, colCfgs: Record<number, ColumnConfig>, position: "replace" | "append",
): Promise<void> {
  const { headers, rows, columns } = parsed;
  const nCols = headers.length;
  const chipCols = new Set<number>();
  for (const col of columns) {
    const t = colCfgs[col.index]?.type ?? col.type;
    if (t === "people_chip" || t === "file_chip") chipCols.add(col.index);
  }
  const vals: any[][] = [headers];
  for (const row of rows) {
    vals.push(row.map((v, ci) => {
      if (v === null) return "";
      const t = (colCfgs[ci]?.type ?? columns[ci]?.type) as ColumnType;
      if (t === "image_formula" && typeof v === "string" && /\.(png|jpg|jpeg|gif|svg|webp)/i.test(v))
        return `=IMAGE("${v}",1)`;
      if (chipCols.has(ci)) return String(v);
      return v;
    }));
  }
  if (position === "replace") {
    const range = `${sheetName}!A1:${colLetter(nCols - 1)}${vals.length}`;
    await sheetsRequest(at, spreadsheetId,
      `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      "PUT", { range, majorDimension: "ROWS", values: vals });
  } else {
    const range = `${sheetName}!A1`;
    await sheetsRequest(at, spreadsheetId,
      `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      "POST", { range, majorDimension: "ROWS", values: vals });
  }
  const fmtReqs: any[] = [];
  for (const col of columns) {
    const cfg = colCfgs[col.index];
    const t = cfg?.type ?? col.type;
    const fmt = buildNumberFormat(t, cfg?.format);
    if (fmt && rows.length > 0) {
      fmtReqs.push({ repeatCell: {
        range: gr(sheetId, 1, rows.length + 1, col.index, col.index + 1),
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: fmt } } },
        fields: "userEnteredFormat.numberFormat",
      }});
    }
    if (t === "boolean" && rows.length > 0) {
      fmtReqs.push({ setDataValidation: {
        range: gr(sheetId, 1, rows.length + 1, col.index, col.index + 1),
        rule: { condition: { type: "BOOLEAN" }, strict: false, showCustomUi: true },
      }});
    }
    if (cfg?.width) {
      fmtReqs.push({ updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: col.index, endIndex: col.index + 1 },
        properties: { pixelSize: cfg.width }, fields: "pixelSize",
      }});
    }
  }
  for (const ci of chipCols) {
    const t = (colCfgs[ci]?.type ?? columns[ci]?.type) as ColumnType;
    const cellData: any[] = rows.map(row => {
      const v = row[ci];
      if (!v && v !== 0) return {};
      const s = String(v);
      if (t === "people_chip" && isEmail(s)) return buildPersonChipCell(s);
      if (t === "file_chip" && isDriveUrl(s)) return buildFileChipCell(s);
      return { userEnteredValue: { stringValue: s } };
    });
    if (cellData.length > 0) {
      fmtReqs.push({ updateCells: {
        rows: cellData.map(cd => ({ values: [cd] })),
        fields: "userEnteredValue,chipRuns",
        start: { sheetId, rowIndex: 1, columnIndex: ci },
      }});
    }
  }
  if (fmtReqs.length > 0) await bu(at, spreadsheetId, fmtReqs);
}

// ── PASS 3 ───────────────────────────────────────────────────────────────────

async function pass3(
  at: string, spreadsheetId: string, sheetId: number, sheetName: string,
  parsed: ParsedSheet, colCfgs: Record<number, ColumnConfig>,
  opts: {
    theme: ThemeName; alternating_rows: boolean; freeze_rows: number; freeze_cols?: number;
    auto_resize_columns: boolean; column_groups?: any[]; section_headers?: any[];
    total_rows?: number[]; summary_row?: boolean;
    conditional_highlight?: { negative_red?: boolean; max_green?: boolean };
    conditional_rules?: any[];
  },
): Promise<void> {
  const { headers, rows, columns } = parsed;
  const nCols = headers.length;
  const nRows = rows.length;
  const totalRows = nRows + (opts.summary_row ? 1 : 0);
  const themeKey: ThemeName = (opts.theme in THEMES ? opts.theme : "corporate") as ThemeName;
  const kc = THEMES[themeKey];
  const tok = deriveSheetTokens(kc, FONT_PAIRS.arial_roboto);
  const reqs: any[] = [];

  // Header
  reqs.push({ repeatCell: {
    range: gr(sheetId, 0, 1, 0, nCols),
    cell: { userEnteredFormat: {
      backgroundColor: rgb(tok.headerBg),
      textFormat: { foregroundColor: rgb(tok.headerText), bold: true, fontSize: tok.headerFontSize, fontFamily: tok.fontFamily },
      horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP",
    }},
    fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
  }});

  // Body font
  if (nRows > 0) {
    reqs.push({ repeatCell: {
      range: gr(sheetId, 1, totalRows + 1, 0, nCols),
      cell: { userEnteredFormat: { textFormat: { fontFamily: tok.fontFamily, fontSize: tok.bodyFontSize }, verticalAlignment: "MIDDLE" } },
      fields: "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment",
    }});
  }

  // Column alignment
  const numTypes = new Set(["currency","percent","integer","decimal"]);
  for (const col of columns) {
    const cfg = colCfgs[col.index];
    const t = (cfg?.type ?? col.type) as ColumnType;
    if (nRows > 0) {
      const alignVal = cfg?.align ? ({left:"LEFT",center:"CENTER",right:"RIGHT"}[cfg.align]) : (numTypes.has(t) ? "RIGHT" : null);
      if (alignVal) reqs.push({ repeatCell: {
        range: gr(sheetId, 1, nRows + 1, col.index, col.index + 1),
        cell: { userEnteredFormat: { horizontalAlignment: alignVal } },
        fields: "userEnteredFormat.horizontalAlignment",
      }});
      if (cfg?.valign) {
        const va = {top:"TOP",middle:"MIDDLE",bottom:"BOTTOM"}[cfg.valign] ?? "MIDDLE";
        reqs.push({ repeatCell: {
          range: gr(sheetId, 1, nRows + 1, col.index, col.index + 1),
          cell: { userEnteredFormat: { verticalAlignment: va } },
          fields: "userEnteredFormat.verticalAlignment",
        }});
      }
    }
  }

  // Banding
  if (opts.alternating_rows && nRows > 0) {
    try {
      const info = await sheetsRequest(at, spreadsheetId, "?fields=sheets(properties.sheetId,bandedRanges)") as any;
      const sheet = (info.sheets || []).find((s: any) => s.properties?.sheetId === sheetId);
      for (const br of (sheet?.bandedRanges || [])) {
        if (br.bandedRangeId) reqs.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
      }
    } catch {}
    reqs.push({ addBanding: { bandedRange: {
      range: gr(sheetId, 0, totalRows + 1, 0, nCols),
      rowProperties: {
        headerColor: rgb(tok.headerBg),
        firstBandColor: rgb("#ffffff"),
        secondBandColor: rgb(tok.altRowBg),
      },
    }}});
  }

  // Freeze
  if (opts.freeze_rows > 0) {
    reqs.push({ updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: opts.freeze_rows } },
      fields: "gridProperties.frozenRowCount",
    }});
  }
  if (opts.freeze_cols && opts.freeze_cols > 0) {
    reqs.push({ updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenColumnCount: opts.freeze_cols } },
      fields: "gridProperties.frozenColumnCount",
    }});
  }

  // Border
  const bdr = { style: "SOLID", color: rgb(tok.borderColor) };
  reqs.push({ updateBorders: {
    range: gr(sheetId, 0, totalRows + 1, 0, nCols),
    top: bdr, bottom: bdr, left: bdr, right: bdr, innerHorizontal: bdr, innerVertical: bdr,
  }});

  if (reqs.length > 0) await bu(at, spreadsheetId, reqs);
  const reqs2: any[] = [];

  // column_groups
  if (opts.column_groups?.length) {
    let offset = 0;
    for (const cg of opts.column_groups) {
      if (cg.span > 1) reqs2.push({ mergeCells: { range: gr(sheetId, 0, 1, offset, offset + cg.span), mergeType: "MERGE_ALL" } });
      reqs2.push({ repeatCell: {
        range: gr(sheetId, 0, 1, offset, offset + cg.span),
        cell: { userEnteredFormat: {
          backgroundColor: rgb(cg.color ?? tok.headerBg),
          textFormat: { bold: true, foregroundColor: rgb("#ffffff") },
          horizontalAlignment: "CENTER",
        }},
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
      }});
      offset += cg.span;
    }
  }

  // total_rows
  if (opts.total_rows?.length && nRows > 0) {
    for (const ri of opts.total_rows) {
      const r = ri + 1;
      reqs2.push({ repeatCell: {
        range: gr(sheetId, r, r + 1, 0, nCols),
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat.bold",
      }});
      reqs2.push({ updateBorders: {
        range: gr(sheetId, r, r + 1, 0, nCols),
        top: { style: "SOLID_MEDIUM", color: rgb(tok.bodyText) },
      }});
    }
  }

  // Status dropdowns + colors
  for (const col of columns) {
    const cfg = colCfgs[col.index];
    const t = (cfg?.type ?? col.type) as ColumnType;
    if (t === "status" && nRows > 0 && col.uniqueValues?.length) {
      reqs2.push({ setDataValidation: {
        range: gr(sheetId, 1, nRows + 1, col.index, col.index + 1),
        rule: {
          condition: { type: "ONE_OF_LIST", values: col.uniqueValues.map(v => ({ userEnteredValue: v })) },
          strict: false, showCustomUi: true,
        },
      }});
      if (cfg?.status_values) {
        for (const [val, colorKey] of Object.entries(cfg.status_values as Record<string,string>)) {
          const bg = STATUS_COLORS[colorKey];
          if (bg) reqs2.push({ addConditionalFormatRule: { rule: {
            ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
            booleanRule: {
              condition: { type: "TEXT_EQ", values: [{ userEnteredValue: val }] },
              format: { backgroundColor: rgb(bg) },
            },
          }, index: 0 }});
        }
      }
    }
    if (cfg?.cell_colors && nRows > 0) {
      for (const [val, hexBg] of Object.entries(cfg.cell_colors as Record<string,string>)) {
        reqs2.push({ addConditionalFormatRule: { rule: {
          ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: val }] },
            format: { backgroundColor: rgb(hexBg) },
          },
        }, index: 0 }});
      }
    }
  }

  // conditional_highlight
  if (opts.conditional_highlight && nRows > 0) {
    for (const col of columns) {
      const t = (colCfgs[col.index]?.type ?? col.type) as ColumnType;
      if (opts.conditional_highlight.negative_red && ["currency","integer","decimal"].includes(t)) {
        reqs2.push({ addConditionalFormatRule: { rule: {
          ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
          booleanRule: {
            condition: { type: "NUMBER_LESS", values: [{ userEnteredValue: "0" }] },
            format: { textFormat: { foregroundColor: rgb("#dc2626") } },
          },
        }, index: 0 }});
      }
      if (opts.conditional_highlight.max_green && ["currency","integer","decimal","percent"].includes(t)) {
        const cA1 = colLetter(col.index);
        reqs2.push({ addConditionalFormatRule: { rule: {
          ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
          booleanRule: {
            condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=${cA1}2=MAX($${cA1}$2:$${cA1}$${nRows + 1})` }] },
            format: { backgroundColor: rgb("#d1fae5") },
          },
        }, index: 0 }});
      }
    }
  }

  // auto resize
  if (opts.auto_resize_columns) {
    reqs2.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: nCols } } });
  }

  if (reqs2.length > 0) await bu(at, spreadsheetId, reqs2);

  // section_headers — insert descending to avoid index drift
  let insertedSectionCount = 0;
  if (opts.section_headers?.length && nRows > 0) {
    const sorted = [...opts.section_headers].sort((a, b) => b.before_row - a.before_row);
    for (const sh of sorted) {
      const insertAt = sh.before_row + 1;
      if (insertAt < 1 || insertAt > nRows + 1) continue;
      await bu(at, spreadsheetId, [{ insertDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: insertAt, endIndex: insertAt + 1 },
        inheritFromBefore: false,
      }}]);
      await bu(at, spreadsheetId, [{ repeatCell: {
        range: gr(sheetId, insertAt, insertAt + 1, 0, nCols),
        cell: { userEnteredFormat: {
          backgroundColor: rgb(kc.primaryDark),
          textFormat: { bold: true, foregroundColor: rgb("#ffffff"), fontSize: 10 },
        }},
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      }}]);
      const lRange = `${sheetName}!A${insertAt + 1}`;
      await sheetsRequest(at, spreadsheetId,
        `/values/${encodeURIComponent(lRange)}?valueInputOption=RAW`, "PUT",
        { range: lRange, values: [[sh.label]] });
      insertedSectionCount++;
    }
  }

  // summary_row — sri must account for inserted section header rows
  if (opts.summary_row && nRows > 0) {
    const sri = nRows + 1 + insertedSectionCount;
    const dataEndRow = nRows + insertedSectionCount + 1; // last data row after section inserts
    const sVals = parsed.headers.map((_, i) => {
      const t = (colCfgs[i]?.type ?? columns[i]?.type) as ColumnType;
      const cA1 = colLetter(i);
      if (["currency","integer","decimal"].includes(t)) return `=SUM(${cA1}2:${cA1}${dataEndRow})`;
      if (t === "percent") return `=AVERAGE(${cA1}2:${cA1}${dataEndRow})`;
      if (i === 0) return "Total";
      return `=COUNTA(${cA1}2:${cA1}${dataEndRow})`;
    });
    const sRange = `${sheetName}!A${sri + 1}:${colLetter(parsed.headers.length - 1)}${sri + 1}`;
    await sheetsRequest(at, spreadsheetId,
      `/values/${encodeURIComponent(sRange)}?valueInputOption=USER_ENTERED`, "PUT",
      { range: sRange, values: [sVals] });
    await bu(at, spreadsheetId, [
      { repeatCell: {
        range: gr(sheetId, sri, sri + 1, 0, parsed.headers.length),
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat.bold",
      }},
      { updateBorders: {
        range: gr(sheetId, sri, sri + 1, 0, parsed.headers.length),
        top: { style: "SOLID_MEDIUM", color: rgb(tok.bodyText) },
      }},
    ]);
  }
}

// ── PASS 4 ───────────────────────────────────────────────────────────────────

async function pass4(
  at: string, spreadsheetId: string, sheetId: number,
  chart?: ChartConfig, overlayImages?: any[],
): Promise<void> {
  if (!chart && !overlayImages?.length) return;
  const reqs: any[] = [];
  if (chart) {
    const gRange = parseA1Range(chart.source_range, sheetId);
    const domainRange = { ...gRange, endColumnIndex: gRange.startColumnIndex + 1 };
    const anchor = chart.position?.anchor_cell ? parseAnchor(chart.position.anchor_cell) : { rowIndex: 1, columnIndex: 0 };
    const spec: any = { title: chart.title || "" };
    if (chart.type === "PIE") {
      spec.pieChart = {
        legendPosition: "RIGHT_LEGEND",
        domain: { sourceRange: { sources: [domainRange] } },
        series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } },
      };
    } else if (chart.type === "TIMELINE") {
      spec.basicChart = {
        chartType: "TIMELINE", headerCount: 1,
        domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
        series: [{ series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } } }],
      };
    } else {
      const sl: any[] = [];
      for (let c = gRange.startColumnIndex + 1; c < gRange.endColumnIndex; c++) {
        sl.push({ series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: c, endColumnIndex: c + 1 }] } } });
      }
      spec.basicChart = {
        chartType: chart.type, legendPosition: "BOTTOM_LEGEND", headerCount: 1,
        axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS" }],
        domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
        series: sl.length ? sl : [{ series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } } }],
      };
    }
    reqs.push({ addChart: { chart: { spec, position: { overlayPosition: {
      anchorCell: { sheetId, rowIndex: anchor.rowIndex, columnIndex: anchor.columnIndex },
      widthPixels: 600, heightPixels: 400,
    }}}}});
  }
  if (overlayImages?.length) {
    for (const img of overlayImages) {
      const a = parseAnchor(img.anchor_cell);
      reqs.push({ addEmbeddedImage: { embeddedImage: {
        image: { sourceUrl: img.url },
        position: { overlayPosition: {
          anchorCell: { sheetId, rowIndex: a.rowIndex, columnIndex: a.columnIndex },
          widthPixels: img.width, heightPixels: img.height,
        }},
      }}});
    }
  }
  if (reqs.length > 0) await bu(at, spreadsheetId, reqs);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function processSheet(
  at: string, spreadsheetId: string, sheetId: number, sheetName: string,
  data: SheetData | WriteSheetInput,
): Promise<{ rows: number; cols: number }> {
  const colCfgs: Record<number, ColumnConfig> = {};
  for (const [k, v] of Object.entries(data.columns ?? {})) colCfgs[parseInt(k)] = v as ColumnConfig;
  const parsed = parseInput(data, colCfgs);
  const theme = (data.theme ?? "corporate") as ThemeName;
  await pass2(at, spreadsheetId, sheetId, sheetName, parsed, colCfgs, data.position ?? "replace");
  await pass3(at, spreadsheetId, sheetId, sheetName, parsed, colCfgs, {
    theme, alternating_rows: data.alternating_rows ?? true,
    freeze_rows: data.freeze_rows ?? 1, freeze_cols: data.freeze_cols,
    auto_resize_columns: data.auto_resize_columns ?? true,
    column_groups: data.column_groups, section_headers: data.section_headers,
    total_rows: data.total_rows, summary_row: data.summary_row,
    conditional_highlight: data.conditional_highlight,
    conditional_rules: data.conditional_rules,
  });
  await pass4(at, spreadsheetId, sheetId, data.chart, data.overlay_images);
  return { rows: parsed.rows.length, cols: parsed.headers.length };
}

export async function executeWriteSheet(
  accessToken: string,
  input: WriteSheetInput,
): Promise<{ spreadsheetId: string; url: string; summary: string[] }> {
  const isCreate = !input.spreadsheet_id;
  const sheetsList: SheetData[] = input.sheets?.length
    ? input.sheets
    : [{ ...input, name: input.sheet_name ?? "Sheet1" } as SheetData];

  let spreadsheetId: string;
  let createdSheets: any[];

  if (isCreate) {
    if (!input.name) throw new Error("Parameter 'name' required when creating new spreadsheet");
    const r = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, "POST",
      { properties: { title: input.name },
        sheets: sheetsList.map((s, i) => ({ properties: { title: s.name, index: i } })) }) as any;
    spreadsheetId = r.spreadsheetId;
    createdSheets = r.sheets;
  } else {
    spreadsheetId = input.spreadsheet_id!;
    const info = await sheetsRequest(accessToken, spreadsheetId, "?fields=sheets(properties(sheetId,title))") as any;
    createdSheets = info.sheets || [];
    for (const s of sheetsList) {
      const exists = createdSheets.find((sh: any) => sh.properties?.title === s.name);
      if (!exists) {
        const r = await bu(accessToken, spreadsheetId, [{ addSheet: { properties: { title: s.name } } }]) as any;
        createdSheets.push(r.replies?.[0]?.addSheet);
      }
    }
  }

  const summary: string[] = [];
  for (const sd of sheetsList) {
    const meta = createdSheets.find((s: any) => s.properties?.title === sd.name);
    const sheetId: number = meta?.properties?.sheetId ?? 0;
    const merged: SheetData = {
      ...sd,
      data: sd.data ?? (input.data as any),
      csv: sd.csv ?? input.csv,
      markdown_table: sd.markdown_table ?? input.markdown_table,
      columns: sd.columns ?? input.columns,
      theme: sd.theme ?? input.theme,
      alternating_rows: sd.alternating_rows ?? input.alternating_rows,
      freeze_rows: sd.freeze_rows ?? input.freeze_rows,
      freeze_cols: sd.freeze_cols ?? input.freeze_cols,
      auto_resize_columns: sd.auto_resize_columns ?? input.auto_resize_columns,
      summary_row: sd.summary_row ?? input.summary_row,
      conditional_highlight: sd.conditional_highlight ?? input.conditional_highlight,
      chart: sd.chart ?? input.chart,
      position: sd.position ?? input.position,
    };
    const { rows, cols } = await processSheet(accessToken, spreadsheetId, sheetId, sd.name, merged);
    summary.push(`  • "${sd.name}": ${cols} cols × ${rows} rows`);
  }
  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, summary };
}
