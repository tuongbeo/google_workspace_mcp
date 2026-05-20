/**
 * tools/write-google-sheet.ts
 * write_google_sheet — unified engine to create/update Google Sheets
 * 4-pass: Parse -> Data -> Style -> Rich elements
 * Replaces: create_spreadsheet, create_formatted_spreadsheet
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withErrorHandler } from "../utils/tool-handler";
import { executeWriteSheet } from "../sheets-engine/executor";
import { WriteSheetInput } from "../sheets-engine/types";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

const colCfgSchema = z.object({
  type: z.enum(["currency","percent","integer","decimal","date","boolean","text",
    "status","people_chip","file_chip","image_formula"]).optional(),
  status_values: z.record(z.string(), z.enum(["green","amber","red","blue","gray"])).optional(),
  cell_colors: z.record(z.string(), z.string()).optional(),
  width: z.number().int().optional(),
  align: z.enum(["left","center","right"]).optional(),
  valign: z.enum(["top","middle","bottom"]).optional(),
  format: z.string().optional(),
});

const colGroupSchema = z.object({
  label: z.string(),
  span: z.number().int().min(1),
  color: z.string().optional(),
});

const secHdrSchema = z.object({
  before_row: z.number().int().min(0),
  label: z.string(),
  indent_rows: z.boolean().optional(),
});

const chartSchema = z.object({
  type: z.enum(["BAR","LINE","PIE","COLUMN","AREA","SCATTER","TIMELINE"]),
  source_range: z.string(),
  title: z.string().optional(),
  position: z.object({ anchor_cell: z.string() }).optional(),
});

const imgSchema = z.object({
  url: z.string(),
  anchor_cell: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

const sheetDataSchema = z.object({
  name: z.string(),
  data: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.union([z.string(),z.number(),z.boolean(),z.null()]))) }).optional(),
  csv: z.string().optional(),
  markdown_table: z.string().optional(),
  column_groups: z.array(colGroupSchema).optional(),
  section_headers: z.array(secHdrSchema).optional(),
  total_rows: z.array(z.number().int()).optional(),
  columns: z.record(z.string(), colCfgSchema).optional(),
  theme: z.enum(["corporate","modern","warm","nature","minimal","vibrant"]).optional(),
  alternating_rows: z.boolean().optional(),
  freeze_rows: z.number().int().optional(),
  freeze_cols: z.number().int().optional(),
  auto_resize_columns: z.boolean().optional(),
  summary_row: z.boolean().optional(),
  conditional_highlight: z.object({ negative_red: z.boolean().optional(), max_green: z.boolean().optional() }).optional(),
  chart: chartSchema.optional(),
  overlay_images: z.array(imgSchema).optional(),
  position: z.enum(["replace","append"]).optional(),
});

export function registerWriteGoogleSheetTool(server: McpServer, getCreds: GetCredsFunc) {
  server.tool(
    "write_google_sheet",
    "Create or update a Google Spreadsheet with full visual styling. " +
    "4-pass engine: auto-detects column types (currency, percent, date, boolean, status, " +
    "people/file smart chips, image formulas), applies number formats, alternating row banding, " +
    "frozen header, alignment, status dropdowns with color chips, conditional highlighting " +
    "(negative red, max green), section headers, total rows, summary row, embedded chart. " +
    "Supports 6 themes: corporate, modern, warm, nature, minimal, vibrant. " +
    "Input: JSON data object, CSV string, or markdown table. " +
    "Create mode: provide name + data. Update mode: provide spreadsheet_id + data. " +
    "Multi-sheet: use sheets[] array. [Supersedes create_spreadsheet and create_formatted_spreadsheet]",
    {
      name: z.string().optional().describe("Spreadsheet name — required when creating new (no spreadsheet_id)"),
      spreadsheet_id: z.string().optional().describe("Existing spreadsheet ID — to update instead of create"),
      sheet_name: z.string().optional().describe("Target tab name. Defaults to Sheet1."),
      sheets: z.array(sheetDataSchema).optional().describe("Create/update multiple tabs at once"),
      data: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.union([z.string(),z.number(),z.boolean(),z.null()]))) }).optional(),
      csv: z.string().optional().describe("Raw CSV string"),
      markdown_table: z.string().optional().describe("Markdown table (| col | col | format)"),
      column_groups: z.array(colGroupSchema).optional().describe("Merge header cells into labeled groups"),
      section_headers: z.array(secHdrSchema).optional().describe("Insert dark divider rows before specified data rows"),
      total_rows: z.array(z.number().int()).optional().describe("Data row indices (0-based) — bold + top border"),
      columns: z.record(z.string(), colCfgSchema).optional().describe("Per-column config keyed by 0-based index string. E.g. {\"0\":{type:\"currency\"}}"),
      theme: z.enum(["corporate","modern","warm","nature","minimal","vibrant"]).optional().default("corporate"),
      alternating_rows: z.boolean().optional().default(true),
      freeze_rows: z.number().int().optional().default(1),
      freeze_cols: z.number().int().optional(),
      auto_resize_columns: z.boolean().optional().default(true),
      summary_row: z.boolean().optional().default(false).describe("Append summary row with SUM/AVERAGE/COUNT formulas"),
      conditional_highlight: z.object({ negative_red: z.boolean().optional(), max_green: z.boolean().optional() }).optional(),
      conditional_rules: z.array(z.object({ range: z.string(), condition: z.record(z.string(),z.unknown()), format: z.record(z.string(),z.unknown()) })).optional(),
      chart: chartSchema.optional(),
      overlay_images: z.array(imgSchema).optional(),
      position: z.enum(["replace","append"]).optional().default("replace"),
    },
    { readOnlyHint: false },
    withErrorHandler(async (params) => {
      const { accessToken } = await getCreds();
      if (!params.sheets?.length) {
        const srcs = [params.data, params.csv, params.markdown_table].filter(Boolean).length;
        if (srcs === 0) throw new Error("Provide exactly one of: data, csv, markdown_table (or use sheets[] for multi-sheet)");
        if (srcs > 1) throw new Error("Provide exactly one of: data, csv, markdown_table");
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
          ? Object.fromEntries(Object.entries(params.columns).map(([k,v]) => [parseInt(k), v]))
          : undefined,
        theme: params.theme as any,
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
      return { content: [{ type: "text", text: [
        `${action}: "${params.name || spreadsheetId}"`,
        `ID: ${spreadsheetId}`,
        `Theme: ${params.theme ?? "corporate"} | Column type auto-detection: enabled`,
        `URL: ${url}`,
        "",
        "Sheets:",
        ...summary,
      ].join("\n") }] };
    }),
  );
}
