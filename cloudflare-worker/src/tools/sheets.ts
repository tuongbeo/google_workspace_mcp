/**
 * Google Sheets MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sheetsRequest, googleFetch } from "../google";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerSheetsTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("get_spreadsheet_info", "Get metadata about a Google Spreadsheet.", {
    spreadsheet_id: z.string(),
  }, async ({ spreadsheet_id }) => {
    const { accessToken } = await getCreds();
    const data = await sheetsRequest(accessToken, spreadsheet_id, "?fields=spreadsheetId,properties,sheets.properties") as any;
    const sheets = (data.sheets || []).map((s: any) =>
      `  - ${s.properties.title} (ID: ${s.properties.sheetId}, ${s.properties.gridProperties?.rowCount}r × ${s.properties.gridProperties?.columnCount}c)`
    );
    return { content: [{ type: "text", text: `Spreadsheet: ${data.properties?.title}\nID: ${data.spreadsheetId}\n\nSheets:\n${sheets.join("\n")}` }] };
  });

  server.tool("list_spreadsheets", "List Google Spreadsheets in Drive.", {
    max_results: z.number().optional().default(20),
    query: z.string().optional().describe("Drive search query filter"),
  }, async ({ max_results = 20, query }) => {
    const { accessToken } = await getCreds();
    let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    if (query) q += ` and name contains '${query}'`;
    const params = new URLSearchParams({ q, fields: "files(id,name,modifiedTime,webViewLink)", pageSize: String(max_results) });
    const data = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken) as any;
    const files = data.files || [];
    if (!files.length) return { content: [{ type: "text", text: "No spreadsheets found." }] };
    const lines = files.map((f: any) => `📊 ${f.name}\n   ID: ${f.id} | Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink}`);
    return { content: [{ type: "text", text: `Found ${files.length} spreadsheets:\n\n${lines.join("\n\n")}` }] };
  });

  server.tool("read_sheet_values", "Read values from a Google Sheets range.", {
    spreadsheet_id: z.string(),
    range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D10'"),
  }, async ({ spreadsheet_id, range }) => {
    const { accessToken } = await getCreds();
    const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}`) as any;
    const values = data.values || [];
    if (!values.length) return { content: [{ type: "text", text: "No data found." }] };
    const lines = values.map((row: any[]) => row.join("\t"));
    return { content: [{ type: "text", text: `Data in ${range} (${values.length} rows):\n\n${lines.join("\n")}` }] };
  });

  server.tool("write_sheet_values", "Write values to a Google Sheets range.", {
    spreadsheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())).describe("2D array of values"),
  }, async ({ spreadsheet_id, range, values }) => {
    const { accessToken } = await getCreds();
    const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, "PUT", { range, majorDimension: "ROWS", values }) as any;
    return { content: [{ type: "text", text: `Updated ${data.updatedRows} rows, ${data.updatedColumns} cols, ${data.updatedCells} cells.` }] };
  });

  server.tool("append_sheet_values", "Append rows to a Google Sheet.", {
    spreadsheet_id: z.string(),
    range: z.string(),
    values: z.array(z.array(z.string())),
  }, async ({ spreadsheet_id, range, values }) => {
    const { accessToken } = await getCreds();
    const data = await sheetsRequest(accessToken, spreadsheet_id, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, "POST", { range, majorDimension: "ROWS", values }) as any;
    return { content: [{ type: "text", text: `Appended ${data.updates?.updatedRows || "?"} rows.` }] };
  });

  server.tool("create_spreadsheet", "Create a new Google Spreadsheet.", {
    title: z.string(),
    sheet_names: z.array(z.string()).optional(),
  }, async ({ title, sheet_names }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { properties: { title } };
    if (sheet_names?.length) body.sheets = sheet_names.map(name => ({ properties: { title: name } }));
    const result = await googleFetch("https://sheets.googleapis.com/v4/spreadsheets", accessToken, "POST", body) as any;
    return { content: [{ type: "text", text: `Spreadsheet created: "${result.properties.title}"\nID: ${result.spreadsheetId}\nURL: https://docs.google.com/spreadsheets/d/${result.spreadsheetId}/edit` }] };
  });

  server.tool("create_sheet", "Add a new sheet (tab) to an existing Spreadsheet.", {
    spreadsheet_id: z.string(),
    title: z.string(),
    index: z.number().optional().describe("Position (0-based)"),
  }, async ({ spreadsheet_id, title, index }) => {
    const { accessToken } = await getCreds();
    const props: Record<string, unknown> = { title };
    if (index !== undefined) props.index = index;
    const result = await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", {
      requests: [{ addSheet: { properties: props } }]
    }) as any;
    const newSheet = result.replies?.[0]?.addSheet?.properties;
    return { content: [{ type: "text", text: `Sheet "${newSheet?.title}" added (ID: ${newSheet?.sheetId}).` }] };
  });

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
  }, async ({ spreadsheet_id, sheet_id, start_row, end_row, start_col, end_col, bold, italic, font_size, bg_color_hex, text_color_hex, number_format, wrap_strategy, horizontal_align }) => {
    const { accessToken } = await getCreds();
    const range = { sheetId: sheet_id, startRowIndex: start_row, endRowIndex: end_row, startColumnIndex: start_col, endColumnIndex: end_col };

    function hexToRgb(hex: string) {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      return { red: r, green: g, blue: b };
    }

    const requests: any[] = [];
    const cellFormat: Record<string, unknown> = {};
    const textFormat: Record<string, unknown> = {};
    let fields = "";
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

    requests.push({ repeatCell: { range, cell: { userEnteredFormat: cellFormat }, fields: fieldParts.join(",") } });
    await sheetsRequest(accessToken, spreadsheet_id, ":batchUpdate", "POST", { requests });
    return { content: [{ type: "text", text: `Formatting applied to range (rows ${start_row}-${end_row}, cols ${start_col}-${end_col}).` }] };
  });
}
