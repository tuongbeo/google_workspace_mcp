/**
 * Google Sheets MCP Tools
 * Consolidated from: sheets.ts, sheets-phase2.ts, write-google-sheet.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sheetsRequest, googleFetch, escapeDriveQueryValue } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { getTheme, hexToSheetsRgb } from "../styles";
import { executeWriteSheet, defuseFormula } from "../sheets-engine/executor";
import { WriteSheetInput } from "../sheets-engine/types";
import type { GetCredsFunc } from "../types";

function _registerSheetsCore(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("get_spreadsheet_info", "Get metadata about a Google Spreadsheet.", {
    spreadsheet_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ spreadsheet_id }) => {
    const { accessToken } = await getCreds();
    const data = await sheetsRequest(accessToken, spreadsheet_id, "?fields=spreadsheetId,properties,sheets.properties") as any;
    const sheets = (data.sheets || []).map((s: any) =>
      `  - ${s.properties.title} (ID: ${s.properties.sheetId}, ${s.properties.gridProperties?.rowCount}r × ${s.properties.gridProperties?.columnCount}c)`
    );
    return { content: [{ type: "text", text: `Spreadsheet: ${data.properties?.title}\nID: ${data.spreadsheetId}\n\nSheets:\n${sheets.join("\n")}` }] };
  }));

  server.tool("list_spreadsheets", "List Google Spreadsheets in Drive.", {
    max_results: z.number().optional().default(20),
    query: z.string().optional().describe("Drive search query filter"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ max_results = 20, query }) => {
    const { accessToken } = await getCreds();
    let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    if (query) q += ` and name contains '${escapeDriveQueryValue(query)}'`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No spreadsheets found." }] };
    const lines = files.map((f: any) => `📊 ${f.name}\n   ID: ${f.id} | Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink}`);
    return { content: [{ type: "text", text: `Found ${files.length} spreadsheets:\n\n${lines.join("\n\n")}` }] };
  }));

  server.tool("read_sheet_values", "Read values from a Google Sheets range, optionally including cell notes.", {
    spreadsheet_id: z.string(),
    range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D10'"),
    include_notes: z.boolean().optional().default(false).describe("Include cell notes/comments alongside values"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ spreadsheet_id, range, include_notes = false }) => {
    const { accessToken } = await getCreds();

    if (!include_notes) {
      const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}`) as any;
      const values = data.values || [];
      if (!values.length) return { content: [{ type: "text", text: "No data found." }] };
      const lines = values.map((row: any[]) => row.join("\t"));
      return { content: [{ type: "text", text: `Data in ${range} (${values.length} rows):\n\n${lines.join("\n")}` }] };
    }

    // Include notes: use spreadsheets.get with includeGridData
    const params = new URLSearchParams({ ranges: range, includeGridData: "true", fields: "sheets.data.rowData.values(formattedValue,note)" });
    const data = await sheetsRequest(accessToken, spreadsheet_id, `?${params}`) as any;
    const rowData = data.sheets?.[0]?.data?.[0]?.rowData || [];
    if (!rowData.length) return { content: [{ type: "text", text: "No data found." }] };
    const lines = rowData.map((row: any) => {
      const cells = row.values || [];
      return cells.map((cell: any) => {
        const val = cell.formattedValue || "";
        const note = cell.note ? ` [note: ${cell.note}]` : "";
        return `${val}${note}`;
      }).join("\t");
    });
    return { content: [{ type: "text", text: `Data in ${range} (${lines.length} rows, with notes):\n\n${lines.join("\n")}` }] };
  }));

  server.tool("write_sheet_values", "Write values to a Google Sheets range.", {
    spreadsheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())).describe("2D array of values"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ spreadsheet_id, range, values }) => {
    const { accessToken } = await getCreds();
    const safeValues = values.map(row => row.map(v => defuseFormula(v)));
    const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, "PUT", { range, majorDimension: "ROWS", values: safeValues }) as any;
    return { content: [{ type: "text", text: `Updated ${data.updatedRows} rows, ${data.updatedColumns} cols, ${data.updatedCells} cells.` }] };
  }));

  server.tool("append_sheet_values", "Append rows to a Google Sheet.", {
    spreadsheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())),
  }, { readOnlyHint: false }, withErrorHandler(async ({ spreadsheet_id, range, values }) => {
    const { accessToken } = await getCreds();
    const safeValues = values.map(row => row.map(v => defuseFormula(v)));
    const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, "POST", { range, majorDimension: "ROWS", values: safeValues }) as any;
    return { content: [{ type: "text", text: `Appended ${data.updates?.updatedRows || "?"} rows.` }] };
  }));

  server.tool("create_spreadsheet",
    "[DEPRECATED — use write_google_sheet] Create a blank Google Spreadsheet. " +
    "Superseded by write_google_sheet which creates AND populates AND formats in a single call. This tool remains functional.",
    {
    title: z.string(),
    sheet_names: z.array(z.string()).optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title, sheet_names }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { properties: { title } };
    if (sheet_names?.length) body.sheets = sheet_names.map(name => ({ properties: { title: name } }));
    const result = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Spreadsheet created: "${result.properties.title}"\nID: ${result.spreadsheetId}\nURL: https://docs.google.com/spreadsheets/d/${result.spreadsheetId}/edit` }] };
  }));

  server.tool("create_sheet", "Add a new sheet (tab) to an existing Spreadsheet.", {
    spreadsheet_id: z.string(),
    title: z.string(),
    index: z.number().optional().describe("Position (0-based)"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ spreadsheet_id, title, index }) => {
    const { accessToken } = await getCreds();
    const props: Record<string, unknown> = { title };
    if (index !== undefined) props.index = index;
    const result = await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", {
      requests: [{ addSheet: { properties: props } }]
    }) as any;
    const newSheet = result.replies?.[0]?.addSheet?.properties;
    return { content: [{ type: "text", text: `Sheet "${newSheet?.title}" added (ID: ${newSheet?.sheetId}).` }] };
  }));

  server.tool("format_sheet_range", "Apply formatting to a Google Sheets range (colors, bold, number format, etc.).", {
    spreadsheet_id: z.string(),
    sheet_id: z.number().describe("Sheet ID (from get_spreadsheet_info)"),
    start_row: z.number().describe("Start row index (0-based)"),
    end_row: z.number().describe("End row index (exclusive)"),
    start_col: z.number().describe("Start column index (0-based)"),
    end_col: z.number().describe("End column index (exclusive)"),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    font_size: z.number().optional(),
    bg_color_hex: z.string().optional().describe("Background color hex, e.g. '#FF0000'"),
    text_color_hex: z.string().optional().describe("Text color hex"),
    number_format: z.string().optional().describe("Number format pattern, e.g. '#,##0.00' or 'MM/DD/YYYY'"),
    wrap_strategy: z.enum(["OVERFLOW_CELL", "LEGACY_WRAP", "CLIP", "WRAP"]).optional(),
    horizontal_align: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ spreadsheet_id, sheet_id, start_row, end_row, start_col, end_col, bold, italic, font_size, bg_color_hex, text_color_hex, number_format, wrap_strategy, horizontal_align }) => {
    const { accessToken } = await getCreds();
    const range = { sheetId: sheet_id, startRowIndex: start_row, endRowIndex: end_row, startColumnIndex: start_col, endColumnIndex: end_col };

    function hexToRgb(hex: string) {
      return { red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 };
    }

    const cellFormat: Record<string, unknown> = {};
    const textFormat: Record<string, unknown> = {};
    const fieldParts: string[] = [];

    if (bold !== undefined) { textFormat.bold = bold; fieldParts.push("userEnteredFormat.textFormat.bold"); }
    if (italic !== undefined) { textFormat.italic = italic; fieldParts.push("userEnteredFormat.textFormat.italic"); }
    if (font_size) { textFormat.fontSize = font_size; fieldParts.push("userEnteredFormat.textFormat.fontSize"); }
    if (text_color_hex) { textFormat.foregroundColor = hexToRgb(text_color_hex); fieldParts.push("userEnteredFormat.textFormat.foregroundColor"); }
    if (bg_color_hex) { cellFormat.backgroundColor = hexToRgb(bg_color_hex); fieldParts.push("userEnteredFormat.backgroundColor"); }
    if (number_format) { cellFormat.numberFormat = { type: "NUMBER", pattern: number_format }; fieldParts.push("userEnteredFormat.numberFormat"); }
    if (wrap_strategy) { cellFormat.wrapStrategy = wrap_strategy; fieldParts.push("userEnteredFormat.wrapStrategy"); }
    if (horizontal_align) { cellFormat.horizontalAlignment = horizontal_align; fieldParts.push("userEnteredFormat.horizontalAlignment"); }
    if (Object.keys(textFormat).length) cellFormat.textFormat = textFormat;

    await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", {
      requests: [{ repeatCell: { range, cell: { userEnteredFormat: cellFormat }, fields: fieldParts.join(",") } }]
    });
    return { content: [{ type: "text", text: `Formatting applied to range (rows ${start_row}-${end_row}, cols ${start_col}-${end_col}).` }] };
  }));

  server.tool("create_formatted_spreadsheet",
    "[DEPRECATED — use write_google_sheet] Create a styled spreadsheet from data. " +
    "Superseded by write_google_sheet which supports all 6 themes, column type auto-detection, " +
    "smartchips, charts, and more. This tool remains functional.",
    {
      title: z.string().describe("Spreadsheet title"),
      sheets: z.array(z.object({
        name: z.string().describe("Sheet tab name"),
        headers: z.array(z.string()).max(MAX_SHEET_COLS).describe("Column header labels"),
        rows: z.array(z.array(z.string())).max(MAX_SHEET_ROWS).describe("Data rows (2D string array)"),
      })).min(1).max(MAX_SHEETS_PER_CALL),
      theme: z.enum(["corporate", "modern", "warm", "nature", "minimal", "vibrant", "blue", "green", "gray", "orange"]).optional().default("corporate")
        .describe("Color theme: corporate (default), modern, warm, nature, minimal, vibrant. Legacy aliases: blue=corporate, green=nature, gray=minimal, orange=warm"),
      number_format_columns: z.array(z.object({
        col_index: z.number().int().min(0).describe("0-based column index"),
        format: z.enum(["currency", "percent", "number", "date", "multiple"])
          .describe("currency=$#,##0 | percent=0.0% | number=#,##0 | date=MM/DD/YYYY | multiple=0.0x"),
      })).optional().describe("Anthropic financial number formats for specific columns"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ title, sheets, theme = "corporate", number_format_columns }) => {
      const { accessToken } = await getCreds();
      // Use shared styles module — resolves legacy aliases automatically
      const themeColors = getTheme(theme);
      const t = {
        header_bg:   themeColors.primary.replace("#", ""),
        header_text: "FFFFFF",
        alt_bg:      themeColors.primaryLight.replace("#", ""),
      };
      function hexRgb(hex: string) { return hexToSheetsRgb("#" + hex.replace("#", "")); }
      const NUMBER_FORMATS: Record<string, string> = {
        currency: '$#,##0;($#,##0);"-"', percent: '0.0%', number: '#,##0',
        date: 'MM/DD/YYYY', multiple: '0.0"x"',
      };
      function colLetter(n: number): string { return n < 26 ? String.fromCharCode(65+n) : String.fromCharCode(64+Math.floor(n/26)) + String.fromCharCode(65+(n%26)); }
      const created = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, "POST",
        { properties: { title }, sheets: sheets.map((s,i) => ({ properties: { title: s.name, index: i } })) }) as any;
      const spreadsheetId: string = created.spreadsheetId;
      const createdSheets: any[] = created.sheets;
      const allReqs: any[] = [];
      for (let si = 0; si < sheets.length; si++) {
        const sheet = sheets[si];
        const sheetId: number = createdSheets[si].properties.sheetId;
        const numCols = sheet.headers.length;
        const numDataRows = sheet.rows.length;
        const totalRows = numDataRows + 1;
        const safeRows = sheet.rows.map((row: any[]) => row.map(v => typeof v === "string" ? defuseFormula(v) : v));
        const values = [sheet.headers, ...safeRows];
        const range = `${sheet.name}!A1:${colLetter(numCols-1)}${totalRows}`;
        await sheetsRequest(accessToken, spreadsheetId, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, "PUT", { range, majorDimension: "ROWS", values });
        allReqs.push({ repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
          cell: { userEnteredFormat: {
            backgroundColor: hexRgb(t.header_bg),
            textFormat: { foregroundColor: hexRgb(t.header_text), bold: true, fontSize: 11, fontFamily: "Arial" },
            horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP",
          }},
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
        }});
        if (numDataRows > 0) {
          allReqs.push({ repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: { textFormat: { fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" }},
            fields: "userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)",
          }});
          for (let r = 1; r < numDataRows; r += 2) {
            allReqs.push({ repeatCell: {
              range: { sheetId, startRowIndex: r+1, endRowIndex: r+2, startColumnIndex: 0, endColumnIndex: numCols },
              cell: { userEnteredFormat: { backgroundColor: hexRgb(t.alt_bg) }},
              fields: "userEnteredFormat.backgroundColor",
            }});
          }
        }
        const border = { style: "SOLID", width: 1, color: { red: 0.82, green: 0.84, blue: 0.87 } };
        allReqs.push({ updateBorders: { range: { sheetId, startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: numCols }, top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border }});
        allReqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" }});
        allReqs.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: numCols } }});
        allReqs.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: "pixelSize" }});
        for (const nf of number_format_columns ?? []) {
          if (nf.col_index < numCols && numDataRows > 0) {
            allReqs.push({ repeatCell: {
              range: { sheetId, startRowIndex: 1, endRowIndex: totalRows, startColumnIndex: nf.col_index, endColumnIndex: nf.col_index+1 },
              cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: NUMBER_FORMATS[nf.format] }}},
              fields: "userEnteredFormat.numberFormat",
            }});
          }
        }
      }
      if (allReqs.length) await sheetsRequest(accessToken, spreadsheetId, ":batchUpdate", "POST", { requests: allReqs });
      return { content: [{ type: "text", text: [
        `Spreadsheet created: "${title}"`,
        `ID: ${spreadsheetId}`,
        `Theme: ${theme} | Font: Arial | Format: Anthropic standard`,
        `URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        "",
        "Sheets:",
        ...sheets.map(s => `  • "${s.name}": ${s.headers.length} cols × ${s.rows.length} rows`),
        "",
        `Applied: header styling, alternating rows, borders, frozen row 1, auto-resize${number_format_columns?.length ? `, ${number_format_columns.length} number format(s)` : ""}.`,
      ].join("\n") }] };
    })
  );

}

// ─── Additional tools to match upstream ──────────────────────────────────────

function _registerSheetsExtra(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("manage_conditional_formatting", "Add, update, or delete conditional formatting rules in a Google Sheet.", {
    spreadsheet_id: z.string(),
    action: z.enum(["add", "delete"]),
    sheet_id: z.number().describe("Sheet ID (from get_spreadsheet_info)"),
    start_row: z.number().optional().default(0),
    end_row: z.number().optional().default(100),
    start_col: z.number().optional().default(0),
    end_col: z.number().optional().default(10),
    rule_type: z.enum(["BLANK", "NOT_BLANK", "TEXT_CONTAINS", "TEXT_EQ", "NUMBER_GREATER", "NUMBER_LESS", "NUMBER_BETWEEN", "CUSTOM_FORMULA"]).optional().default("BLANK"),
    condition_value: z.string().optional().describe("Value for condition (e.g., text to match, number, or formula like '=A1>0')"),
    bg_color_hex: z.string().optional().describe("Background color on match, e.g. '#FF0000'"),
    text_color_hex: z.string().optional(),
    bold: z.boolean().optional(),
    rule_index: z.number().optional().describe("Rule index to delete (for delete action)"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ spreadsheet_id, action, sheet_id, start_row = 0, end_row = 100, start_col = 0, end_col = 10, rule_type = "BLANK", condition_value, bg_color_hex, text_color_hex, bold, rule_index }) => {
    const { accessToken } = await getCreds();

    function hexToRgb(hex: string) {
      return { red: parseInt(hex.slice(1,3),16)/255, green: parseInt(hex.slice(3,5),16)/255, blue: parseInt(hex.slice(5,7),16)/255 };
    }

    if (action === "delete") {
      await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", {
        requests: [{ deleteConditionalFormatRule: { sheetId: sheet_id, index: rule_index || 0 } }]
      });
      return { content: [{ type: "text", text: `Conditional formatting rule ${rule_index ?? 0} deleted from sheet ${sheet_id}.` }] };
    }

    const range = { sheetId: sheet_id, startRowIndex: start_row, endRowIndex: end_row, startColumnIndex: start_col, endColumnIndex: end_col };
    const format: Record<string, unknown> = {};
    if (bg_color_hex) format.backgroundColor = hexToRgb(bg_color_hex);
    const textFmt: Record<string, unknown> = {};
    if (text_color_hex) textFmt.foregroundColor = hexToRgb(text_color_hex);
    if (bold !== undefined) textFmt.bold = bold;
    if (Object.keys(textFmt).length) format.textFormat = textFmt;

    const condition: Record<string, unknown> = { type: rule_type };
    if (condition_value) condition.values = [{ userEnteredValue: condition_value }];

    await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", {
      requests: [{ addConditionalFormatRule: { rule: { ranges: [range], booleanRule: { condition, format } }, index: 0 } }]
    });
    return { content: [{ type: "text", text: `Conditional formatting rule added to sheet ${sheet_id} (rows ${start_row}-${end_row}, cols ${start_col}-${end_col}).` }] };
  }));
}


function hexRgb(hex: string) {
  const h = hex.replace("#","");
  return { red: parseInt(h.slice(0,2),16)/255, green: parseInt(h.slice(2,4),16)/255, blue: parseInt(h.slice(4,6),16)/255 };
}

function parseRange(r: { startRow: number; endRow: number; startCol: number; endCol: number }, sheetId: number) {
  return { sheetId, startRowIndex: r.startRow, endRowIndex: r.endRow, startColumnIndex: r.startCol, endColumnIndex: r.endCol };
}

async function batchUpdate(accessToken: string, spreadsheetId: string, requests: unknown[]) {
  return sheetsRequest(accessToken, spreadsheetId, ":batchUpdate", "POST", { requests });
}

/** Parse A1-notation range like "Sheet1!A1:D7" into GridRange with sheetId */
function parseA1ToGridRange(a1: string, sheetId: number) {
  // Strip sheet name if present
  const cellPart = a1.includes("!") ? a1.split("!")[1] : a1;
  const match = cellPart.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return { sheetId, startRowIndex: 0, endRowIndex: 0, startColumnIndex: 0, endColumnIndex: 0 };
  const colToIdx = (col: string) => col.toUpperCase().split("").reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return {
    sheetId,
    startRowIndex:    parseInt(match[2]) - 1,
    endRowIndex:      parseInt(match[4]),
    startColumnIndex: colToIdx(match[1]),
    endColumnIndex:   colToIdx(match[3]) + 1,
  };
}

function _registerSheetsPhase2(server: McpServer, getCreds: GetCredsFunc) {

  // ── manage_charts ───────────────────────────────────────────────────────────

  server.tool("manage_charts",
    "Create, update, delete, or list embedded charts in a Google Sheet.",
    {
      action:         z.enum(["create","update","delete","list"]),
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().optional().describe("Sheet ID (0 = first sheet). Required for create."),
      chart_id:       z.number().int().optional().describe("Existing chart ID. Required for update/delete."),
      chart_type:     z.enum(["BAR","LINE","PIE","COLUMN","AREA","SCATTER","TIMELINE"]).optional(),
      source_range:   z.string().optional().describe("A1 notation, e.g. 'Sheet1!A1:C10'"),
      title:          z.string().optional(),
      position: z.object({
        row: z.number().int().optional().default(0),
        col: z.number().int().optional().default(0),
      }).optional(),
      legend_position: z.enum(["BOTTOM_LEGEND","LEFT_LEGEND","RIGHT_LEGEND","TOP_LEGEND","NO_LEGEND"]).optional(),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, spreadsheet_id, sheet_id = 0, chart_id, chart_type, source_range, title, position, legend_position }) => {
      const { accessToken } = await getCreds();

      if (action === "list") {
        const data = await sheetsRequest(accessToken, spreadsheet_id, "?fields=sheets.charts,sheets.properties") as any;
        const lines: string[] = [];
        for (const sheet of (data.sheets || [])) {
          for (const chart of (sheet.charts || [])) {
            lines.push(`Chart ID: ${chart.chartId} | Type: ${chart.spec?.basicChart?.chartType || chart.spec?.pieChart ? "PIE" : "?"} | Title: ${chart.spec?.title || "(no title)"}`);
          }
        }
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No charts found." }] };
      }

      if (action === "delete") {
        if (!chart_id) throw new Error("chart_id required for delete");
        await batchUpdate(accessToken, spreadsheet_id, [{ deleteEmbeddedObject: { objectId: chart_id } }]);
        return { content: [{ type: "text", text: `Chart ${chart_id} deleted.` }] };
      }

      if (action === "create") {
        if (!source_range) throw new Error("source_range required for create");
        const gridRange = parseA1ToGridRange(source_range, sheet_id ?? 0);
        // Domain = first column, series = remaining columns
        const domainRange = { ...gridRange, endColumnIndex: gridRange.startColumnIndex + 1 };
        const spec: any = { title: title || "" };

        if (chart_type === "PIE") {
          spec.pieChart = {
            legendPosition: legend_position || "RIGHT_LEGEND",
            domain: { sourceRange: { sources: [domainRange] } },
            series: { sourceRange: { sources: [{ ...gridRange, startColumnIndex: gridRange.startColumnIndex + 1 }] } },
          };
        } else if (chart_type === "TIMELINE") {
          spec.basicChart = {
            chartType: "TIMELINE",
            headerCount: 1,
            axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS" }],
            domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
            series: [{
              series: { sourceRange: { sources: [{ ...gridRange, startColumnIndex: gridRange.startColumnIndex + 1 }] } },
            }],
          };
        } else {
          // Build one series per column beyond domain
          const seriesList = [];
          for (let c = gridRange.startColumnIndex + 1; c < gridRange.endColumnIndex; c++) {
            seriesList.push({
              series: { sourceRange: { sources: [{ ...gridRange, startColumnIndex: c, endColumnIndex: c + 1 }] } },
            });
          }
          spec.basicChart = {
            chartType: chart_type || "COLUMN",
            legendPosition: legend_position || "BOTTOM_LEGEND",
            headerCount: 1,
            axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS" }],
            domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
            series: seriesList.length ? seriesList : [{
              series: { sourceRange: { sources: [{ ...gridRange, startColumnIndex: gridRange.startColumnIndex + 1 }] } },
            }],
          };
        }

        const req = {
          addChart: {
            chart: {
              spec,
              position: {
                overlayPosition: {
                  anchorCell: { sheetId: sheet_id ?? 0, rowIndex: position?.row ?? 1, columnIndex: position?.col ?? 0 },
                  widthPixels: 600, heightPixels: 400,
                },
              },
            },
          },
        };
        const res = await batchUpdate(accessToken, spreadsheet_id, [req]) as any;
        const newChartId = res.replies?.[0]?.addChart?.chart?.chartId;
        return { content: [{ type: "text", text: `Chart created. ID: ${newChartId}` }] };
      }

      if (action === "update") {
        if (!chart_id) throw new Error("chart_id required for update");
        const updateReq: any = { updateChartSpec: { chartId: chart_id, spec: {} } };
        if (title) updateReq.updateChartSpec.spec.title = title;
        await batchUpdate(accessToken, spreadsheet_id, [updateReq]);
        return { content: [{ type: "text", text: `Chart ${chart_id} updated.` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

  // ── manage_data_validation ──────────────────────────────────────────────────

  server.tool("manage_data_validation",
    "Set or clear data validation rules (dropdowns, number ranges, dates, custom formulas) on Sheets cells.",
    {
      action:         z.enum(["set","clear"]),
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().default(0),
      range:          z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }),
      rule_type:      z.enum(["ONE_OF_LIST","NUMBER_BETWEEN","DATE_VALID","CUSTOM_FORMULA","BOOLEAN"]).optional(),
      values:         z.array(z.string()).optional().describe("For ONE_OF_LIST: allowed values"),
      formula:        z.string().optional().describe("For CUSTOM_FORMULA: e.g. '=A1>0'"),
      min_value:      z.string().optional().describe("For NUMBER_BETWEEN: minimum"),
      max_value:      z.string().optional().describe("For NUMBER_BETWEEN: maximum"),
      input_message:  z.string().optional(),
      strict:         z.boolean().optional().default(false).describe("Reject invalid input if true"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, spreadsheet_id, sheet_id, range, rule_type, values, formula, min_value, max_value, input_message, strict }) => {
      const { accessToken } = await getCreds();
      const gridRange = parseRange(range, sheet_id);

      if (action === "clear") {
        await batchUpdate(accessToken, spreadsheet_id, [{
          setDataValidation: { range: gridRange, rule: null },
        }]);
        return { content: [{ type: "text", text: "Data validation cleared." }] };
      }

      let condition: any;
      if (rule_type === "ONE_OF_LIST") {
        condition = { type: "ONE_OF_LIST", values: (values||[]).map(v => ({ userEnteredValue: v })) };
      } else if (rule_type === "NUMBER_BETWEEN") {
        condition = { type: "NUMBER_BETWEEN", values: [{ userEnteredValue: min_value||"0" }, { userEnteredValue: max_value||"100" }] };
      } else if (rule_type === "DATE_VALID") {
        condition = { type: "DATE_IS_VALID" };
      } else if (rule_type === "CUSTOM_FORMULA") {
        condition = { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula||"=TRUE" }] };
      } else if (rule_type === "BOOLEAN") {
        condition = { type: "BOOLEAN" };
      } else {
        throw new Error("rule_type required for set action");
      }

      const rule: any = { condition, strict: strict ?? false, showCustomUi: true };
      if (input_message) rule.inputMessage = input_message;

      await batchUpdate(accessToken, spreadsheet_id, [{
        setDataValidation: { range: gridRange, rule },
      }]);
      return { content: [{ type: "text", text: `Data validation (${rule_type}) applied to range.` }] };
    }),
  );

  // ── sort_range ──────────────────────────────────────────────────────────────

  server.tool("sort_range",
    "Sort a range of cells in a Google Sheet by one or more columns.",
    {
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().default(0),
      range:          z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }),
      sort_specs:     z.array(z.object({
        column_index: z.number().int().describe("0-based column index within the range"),
        order:        z.enum(["ASC","DESC"]).default("ASC"),
      })).min(1),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ spreadsheet_id, sheet_id, range, sort_specs }) => {
      const { accessToken } = await getCreds();
      await batchUpdate(accessToken, spreadsheet_id, [{
        sortRange: {
          range: parseRange(range, sheet_id),
          sortSpecs: sort_specs.map(s => ({
            dimensionIndex: s.column_index,
            sortOrder: s.order === "ASC" ? "ASCENDING" : "DESCENDING",
          })),
        },
      }]);
      return { content: [{ type: "text", text: `Range sorted by ${sort_specs.length} column(s).` }] };
    }),
  );

  // ── manage_cell_merge ───────────────────────────────────────────────────────

  server.tool("manage_cell_merge",
    "Merge or unmerge cells in a Google Sheet.",
    {
      action:         z.enum(["merge","unmerge"]),
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().default(0),
      range:          z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }),
      merge_type:     z.enum(["MERGE_ALL","MERGE_COLUMNS","MERGE_ROWS"]).optional().default("MERGE_ALL"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, spreadsheet_id, sheet_id, range, merge_type }) => {
      const { accessToken } = await getCreds();
      const gridRange = parseRange(range, sheet_id);
      if (action === "merge") {
        await batchUpdate(accessToken, spreadsheet_id, [{ mergeCells: { range: gridRange, mergeType: merge_type } }]);
        return { content: [{ type: "text", text: `Cells merged (${merge_type}).` }] };
      } else {
        await batchUpdate(accessToken, spreadsheet_id, [{ unmergeCells: { range: gridRange } }]);
        return { content: [{ type: "text", text: "Cells unmerged." }] };
      }
    }),
  );

  // ── create_pivot_table ──────────────────────────────────────────────────────

  server.tool("create_pivot_table",
    "Create a pivot table in a Google Sheet from a source data range.",
    {
      spreadsheet_id:  z.string(),
      source_sheet_id: z.number().int().default(0),
      source_range:    z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }),
      target_sheet_id: z.number().int().optional().describe("Sheet to place pivot table. Defaults to source sheet."),
      target_row:      z.number().int().optional().default(0),
      target_col:      z.number().int().optional().default(0),
      rows: z.array(z.object({
        source_column: z.number().int().describe("0-based source column index"),
        sort_order:    z.enum(["ASC","DESC"]).optional().default("ASC"),
        show_totals:   z.boolean().optional().default(true),
      })),
      columns: z.array(z.object({
        source_column: z.number().int(),
        sort_order:    z.enum(["ASC","DESC"]).optional().default("ASC"),
        show_totals:   z.boolean().optional().default(true),
      })).optional(),
      values: z.array(z.object({
        source_column:       z.number().int(),
        summarize_function:  z.enum(["SUM","COUNT","AVERAGE","MAX","MIN","COUNTUNIQUE","PRODUCT","STDEV","STDEVP","VAR","VARP"]).default("SUM"),
        name:                z.string().optional(),
      })).min(1),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ spreadsheet_id, source_sheet_id, source_range, target_sheet_id, target_row = 0, target_col = 0, rows, columns, values }) => {
      const { accessToken } = await getCreds();
      const targetSheetId = target_sheet_id ?? source_sheet_id;
      const pivotTable: any = {
        source: parseRange(source_range, source_sheet_id),
        rows: rows.map(r => ({
          sourceColumnOffset: r.source_column,
          sortOrder: r.sort_order === "ASC" ? "ASCENDING" : "DESCENDING",
          showTotals: r.show_totals ?? true,
        })),
        values: values.map(v => ({
          sourceColumnOffset: v.source_column,
          summarizeFunction: v.summarize_function,
          name: v.name,
        })),
      };
      if (columns?.length) {
        pivotTable.columns = columns.map(c => ({
          sourceColumnOffset: c.source_column,
          sortOrder: c.sort_order === "ASC" ? "ASCENDING" : "DESCENDING",
          showTotals: c.show_totals ?? true,
        }));
      }
      await batchUpdate(accessToken, spreadsheet_id, [{
        updateCells: {
          rows: [{ values: [{ pivotTable }] }],
          fields: "pivotTable",
          start: { sheetId: targetSheetId, rowIndex: target_row, columnIndex: target_col },
        },
      }]);
      return { content: [{ type: "text", text: `Pivot table created on sheet ID ${targetSheetId} at row ${target_row}, col ${target_col}.` }] };
    }),
  );

  // ── manage_sheet_properties ─────────────────────────────────────────────────

  server.tool("manage_sheet_properties",
    "Manage sheet tab properties: set tab color, freeze rows/columns, rename, hide, or show a sheet.",
    {
      action:         z.enum(["set_tab_color","freeze_rows","freeze_columns","rename","hide","show"]),
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int(),
      color_hex:      z.string().optional().describe("For set_tab_color: hex color, e.g. '#FF0000'"),
      count:          z.number().int().optional().describe("For freeze_rows/freeze_columns: number to freeze"),
      title:          z.string().optional().describe("For rename: new sheet name"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, spreadsheet_id, sheet_id, color_hex, count, title }) => {
      const { accessToken } = await getCreds();
      const props: any = { sheetId: sheet_id };
      const fields: string[] = [];

      if (action === "set_tab_color") {
        if (!color_hex) throw new Error("color_hex required");
        props.tabColorStyle = { rgbColor: hexRgb(color_hex) };
        fields.push("tabColorStyle");
      } else if (action === "freeze_rows") {
        props.gridProperties = { frozenRowCount: count ?? 1 };
        fields.push("gridProperties.frozenRowCount");
      } else if (action === "freeze_columns") {
        props.gridProperties = { frozenColumnCount: count ?? 1 };
        fields.push("gridProperties.frozenColumnCount");
      } else if (action === "rename") {
        if (!title) throw new Error("title required for rename");
        props.title = title;
        fields.push("title");
      } else if (action === "hide") {
        props.hidden = true;
        fields.push("hidden");
      } else if (action === "show") {
        props.hidden = false;
        fields.push("hidden");
      }

      await batchUpdate(accessToken, spreadsheet_id, [{
        updateSheetProperties: { properties: props, fields: fields.join(",") },
      }]);
      return { content: [{ type: "text", text: `Sheet property "${action}" applied.` }] };
    }),
  );

  // ── add_filter_view ─────────────────────────────────────────────────────────

  server.tool("add_filter_view",
    "Add a named filter view to a Google Sheet. Also supports setting a basic (persistent) filter.",
    {
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().default(0),
      range:          z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }),
      title:          z.string().optional().describe("Filter view name. If omitted, sets a basic filter instead."),
      sort_specs: z.array(z.object({
        column_index: z.number().int(),
        order:        z.enum(["ASC","DESC"]).default("ASC"),
      })).optional(),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ spreadsheet_id, sheet_id, range, title, sort_specs }) => {
      const { accessToken } = await getCreds();
      const gridRange = parseRange(range, sheet_id);

      if (title) {
        // Named filter view
        const filterView: any = { title, range: gridRange };
        if (sort_specs?.length) {
          filterView.sortSpecs = sort_specs.map(s => ({
            dimensionIndex: s.column_index,
            sortOrder: s.order === "ASC" ? "ASCENDING" : "DESCENDING",
          }));
        }
        const res = await batchUpdate(accessToken, spreadsheet_id, [{ addFilterView: { filter: filterView } }]) as any;
        const id = res.replies?.[0]?.addFilterView?.filter?.filterViewId;
        return { content: [{ type: "text", text: `Filter view "${title}" created. ID: ${id}` }] };
      } else {
        // Basic filter (persistent, affects the sheet directly)
        const filter: any = { range: gridRange };
        if (sort_specs?.length) {
          filter.sortSpecs = sort_specs.map(s => ({
            dimensionIndex: s.column_index,
            sortOrder: s.order === "ASC" ? "ASCENDING" : "DESCENDING",
          }));
        }
        await batchUpdate(accessToken, spreadsheet_id, [{ setBasicFilter: { filter } }]);
        return { content: [{ type: "text", text: "Basic filter applied to range." }] };
      }
    }),
  );

  // ── add_protected_range ─────────────────────────────────────────────────────

  server.tool("add_protected_range",
    "[DEPRECATED — use batch_update_spreadsheet] Protect a range or sheet in Google Sheets. " +
    "Use batch_update_spreadsheet with an addProtectedRange request. This tool remains functional.",
    {
      spreadsheet_id: z.string(),
      sheet_id:       z.number().int().default(0),
      range:          z.object({ startRow: z.number().int(), endRow: z.number().int(), startCol: z.number().int(), endCol: z.number().int() }).optional().describe("Omit to protect entire sheet"),
      description:    z.string().optional(),
      warning_only:   z.boolean().optional().default(false),
      editors:        z.array(z.string()).optional().describe("Email addresses allowed to edit"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ spreadsheet_id, sheet_id, range, description, warning_only, editors }) => {
      const { accessToken } = await getCreds();
      const protectedRange: any = {
        description: description || "Protected range",
        warningOnly: warning_only,
      };
      if (range) {
        protectedRange.range = parseRange(range, sheet_id);
      } else {
        protectedRange.range = { sheetId: sheet_id };
      }
      if (!warning_only && editors?.length) {
        protectedRange.editors = { users: editors };
      }
      const res = await batchUpdate(accessToken, spreadsheet_id, [{ addProtectedRange: { protectedRange } }]) as any;
      const pid = res.replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;
      return { content: [{ type: "text", text: `Protected range added. ID: ${pid}` }] };
    }),
  );

  // ── batch_update_spreadsheet ────────────────────────────────────────────────

  server.tool("batch_update_spreadsheet",
    "Send raw batchUpdate requests to Google Sheets API. Escape hatch for operations not covered by other tools. " +
    "See Sheets API batchUpdate docs for request types.",
    {
      spreadsheet_id: z.string(),
      requests:       z.array(z.record(z.unknown())).describe("Array of Sheets batchUpdate request objects"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ spreadsheet_id, requests }) => {
      const { accessToken } = await getCreds();
      const result = await batchUpdate(accessToken, spreadsheet_id, requests) as any;
      const replyCount = result.replies?.length ?? 0;
      return { content: [{ type: "text", text: `batchUpdate completed. ${requests.length} request(s), ${replyCount} reply/replies.\nSpreadsheetId: ${result.spreadsheetId}` }] };
    }),
  );

} // end registerSheetsPhase2Tools


// ── Zod sub-schemas ──────────────────────────────────────────────────────────

const columnConfigSchema = z.object({
  type: z.enum([
    "currency","percent","integer","decimal","date","boolean","text",
    "status","people_chip","file_chip","image_formula",
  ]).optional().describe("Force column type (overrides auto-detection)"),
  status_values: z.record(z.string(), z.enum(["green","amber","red","blue","gray"])).optional()
    .describe("For status columns: map value → color chip"),
  cell_colors: z.record(z.string(), z.string()).optional()
    .describe("Map cell value → hex background color"),
  width: z.number().int().optional().describe("Column width in pixels"),
  align: z.enum(["left","center","right"]).optional(),
  valign: z.enum(["top","middle","bottom"]).optional(),
  format: z.string().optional().describe("Custom Sheets number format, e.g. '#,##0.00'"),
});

const columnGroupSchema = z.object({
  label: z.string(),
  span: z.number().int().min(1),
  color: z.string().optional(),
});

const sectionHeaderSchema = z.object({
  before_row: z.number().int().min(0)
    .describe("Insert before this data row index (0-based, not counting header)"),
  label: z.string(),
  indent_rows: z.boolean().optional(),
});

const chartSchema = z.object({
  type: z.enum(["BAR","LINE","PIE","COLUMN","AREA","SCATTER","TIMELINE"]),
  source_range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D20'"),
  title: z.string().optional(),
  position: z.object({ anchor_cell: z.string().describe("Cell like 'F2'") }).optional(),
});

const overlayImageSchema = z.object({
  url: z.string(),
  anchor_cell: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

// Caps prevent a single call from building a batchUpdate request large enough
// to exceed Google Sheets' request-size limits or exhaust Worker CPU/memory
// while constructing it — well above any realistic legitimate sheet.
const MAX_SHEET_ROWS = 10_000;
const MAX_SHEET_COLS = 200;
const MAX_SHEETS_PER_CALL = 50;

const sheetDataSchema = z.object({
  name: z.string().describe("Tab name"),
  data: z.object({
    headers: z.array(z.string()).max(MAX_SHEET_COLS),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(MAX_SHEET_ROWS),
  }).optional(),
  csv: z.string().optional(),
  markdown_table: z.string().optional(),
  column_groups: z.array(columnGroupSchema).optional(),
  section_headers: z.array(sectionHeaderSchema).max(MAX_SHEET_ROWS).optional(),
  total_rows: z.array(z.number().int()).max(MAX_SHEET_ROWS).optional(),
  columns: z.record(z.string(), columnConfigSchema).optional(),
  theme: z.enum(["corporate","modern","warm","nature","minimal","vibrant"]).optional(),
  alternating_rows: z.boolean().optional(),
  freeze_rows: z.number().int().optional(),
  freeze_cols: z.number().int().optional(),
  auto_resize_columns: z.boolean().optional(),
  summary_row: z.boolean().optional(),
  conditional_highlight: z.object({
    negative_red: z.boolean().optional(),
    max_green: z.boolean().optional(),
  }).optional(),
  chart: chartSchema.optional(),
  overlay_images: z.array(overlayImageSchema).optional(),
  position: z.enum(["replace","append"]).optional(),
});

// ── Tool registration ─────────────────────────────────────────────────────────

function _registerWriteGoogleSheet(server: McpServer, getCreds: GetCredsFunc) {
  server.tool(
    "write_google_sheet",
    "Create or update a Google Spreadsheet with full visual styling. " +
    "4-pass engine: auto-detects column types (currency, percent, date, boolean, status, " +
    "people/file smart chips, image formulas), applies number formats, alternating row banding, " +
    "frozen header, column alignment, status dropdowns with color chips, conditional highlighting " +
    "(negative red, max green), section headers, total rows, summary row, embedded chart. " +
    "Supports 6 themes: corporate, modern, warm, nature, minimal, vibrant. " +
    "Input formats: JSON data object, CSV string, or markdown table. " +
    "Create mode: provide name + data. Update mode: provide spreadsheet_id + data. " +
    "Multi-sheet: use sheets[] array. " +
    "[Supersedes create_spreadsheet and create_formatted_spreadsheet]",
    {
      name: z.string().optional()
        .describe("Spreadsheet name — required when creating new (no spreadsheet_id)"),
      spreadsheet_id: z.string().optional()
        .describe("Existing spreadsheet ID — provide to update instead of create"),
      sheet_name: z.string().optional()
        .describe("Target tab name. Defaults to 'Sheet1'."),
      sheets: z.array(sheetDataSchema).max(MAX_SHEETS_PER_CALL).optional()
        .describe("Create multiple tabs at once."),
      data: z.object({
        headers: z.array(z.string()).max(MAX_SHEET_COLS),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(MAX_SHEET_ROWS),
      }).optional().describe("Structured data with headers + rows array"),
      csv: z.string().optional().describe("Raw CSV string"),
      markdown_table: z.string().optional().describe("Markdown table (| col | col | format)"),
      column_groups: z.array(columnGroupSchema).optional()
        .describe("Merge header cells into labeled groups spanning multiple columns"),
      section_headers: z.array(sectionHeaderSchema).max(MAX_SHEET_ROWS).optional()
        .describe("Insert dark divider rows before specified data rows"),
      total_rows: z.array(z.number().int()).max(MAX_SHEET_ROWS).optional()
        .describe("Data row indices (0-based) to style as totals: bold + top border"),
      columns: z.record(z.string(), columnConfigSchema).optional()
        .describe("Per-column config keyed by 0-based index as string. E.g. {'0':{type:'currency'}}"),
      theme: z.enum(["corporate","modern","warm","nature","minimal","vibrant"])
        .optional().default("corporate"),
      font_pair: z.enum(["open_roboto","raleway_noto","merriweather_open","mulish_nunito"])
        .optional().default("open_roboto")
        .describe("Font pair for header and body text"),
      alternating_rows: z.boolean().optional().default(true),
      freeze_rows: z.number().int().optional().default(1),
      freeze_cols: z.number().int().optional(),
      auto_resize_columns: z.boolean().optional().default(true),
      summary_row: z.boolean().optional().default(false)
        .describe("Append summary row with SUM/AVERAGE/COUNT formulas"),
      conditional_highlight: z.object({
        negative_red: z.boolean().optional(),
        max_green: z.boolean().optional(),
      }).optional(),
      conditional_rules: z.array(z.object({
        range: z.string(),
        condition: z.record(z.string(), z.unknown()),
        format: z.record(z.string(), z.unknown()),
      })).optional(),
      chart: chartSchema.optional(),
      overlay_images: z.array(overlayImageSchema).optional(),
      position: z.enum(["replace","append"]).optional().default("replace"),
    },
    { readOnlyHint: false },
    withErrorHandler(async (params) => {
      const { accessToken } = await getCreds();

      if (!params.sheets?.length) {
        const sources = [params.data, params.csv, params.markdown_table].filter(Boolean).length;
        if (sources === 0) throw new Error("Provide exactly one of: data, csv, markdown_table (or use sheets[] for multi-sheet)");
        if (sources > 1) throw new Error("Provide exactly one of: data, csv, markdown_table");
      }

      const input: WriteSheetInput = {
        name: params.name,
        spreadsheet_id: params.spreadsheet_id,
        sheet_name: params.sheet_name,
        sheets: params.sheets as any,
        data: params.data as any,
        csv: params.csv,
        markdown_table: params.markdown_table,
        column_groups: params.column_groups,
        section_headers: params.section_headers,
        total_rows: params.total_rows,
        columns: params.columns
          ? Object.fromEntries(Object.entries(params.columns).map(([k, v]) => [parseInt(k), v]))
          : undefined,
        theme: params.theme as any,
        font_pair: params.font_pair as any,
        alternating_rows: params.alternating_rows,
        freeze_rows: params.freeze_rows,
        freeze_cols: params.freeze_cols,
        auto_resize_columns: params.auto_resize_columns,
        summary_row: params.summary_row,
        conditional_highlight: params.conditional_highlight,
        conditional_rules: params.conditional_rules as any,
        chart: params.chart as any,
        overlay_images: params.overlay_images as any,
        position: params.position as any,
      };

      const { spreadsheetId, url, summary } = await executeWriteSheet(accessToken, input);
      const action = params.spreadsheet_id ? "Updated" : "Created";

      return {
        content: [{
          type: "text",
          text: [
            `${action}: "${params.name || spreadsheetId}"`,
            `ID: ${spreadsheetId}`,
            `Theme: ${params.theme ?? "corporate"} | Column type auto-detection: enabled`,
            `URL: ${url}`,
            "",
            "Sheets:",
            ...summary,
          ].join("\n"),
        }],
      };
    }),
  );
}

// ── Unified entry point ───────────────────────────────────────────────────────

export function registerSheetsTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerSheetsCore(server, getCreds);
  _registerSheetsExtra(server, getCreds);
  _registerSheetsPhase2(server, getCreds);
  _registerWriteGoogleSheet(server, getCreds);
}
