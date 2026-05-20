/**
 * Google Sheets — Phase 2B Extra Tools
 * Adds: manage_charts, manage_data_validation, sort_range, manage_cell_merge,
 *       create_pivot_table, manage_sheet_properties, add_filter_view,
 *       add_protected_range, batch_update_spreadsheet
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sheetsRequest, googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

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

export function registerSheetsPhase2Tools(server: McpServer, getCreds: GetCredsFunc) {

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
        source: { sheetId: source_sheet_id, ...parseRange(source_range, source_sheet_id) },
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
