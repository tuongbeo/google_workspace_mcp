/**
 * Google Docs — Phase 2C Tools
 * Adds: manage_table_cells, insert_section_break, delete_paragraph_bullets
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { docsRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";


export function registerDocsPhase2Tools(server: McpServer, getCreds: GetCredsFunc) {

  // ── manage_table_cells ──────────────────────────────────────────────────────

  server.tool("manage_table_cells",
    "Merge/unmerge table cells, set column widths, or set row min-height in a Google Doc.",
    {
      action:           z.enum(["merge","unmerge","set_column_width","set_row_height"]),
      document_id:      z.string(),
      table_start_index: z.number().int().describe("Character index where the table starts (from inspect_doc_structure)"),
      row_start:        z.number().int().optional().describe("0-based start row (merge/unmerge)"),
      row_end:          z.number().int().optional().describe("0-based end row exclusive (merge/unmerge)"),
      col_start:        z.number().int().optional().describe("0-based start col (merge/unmerge/set_column_width)"),
      col_end:          z.number().int().optional().describe("0-based end col exclusive (merge/unmerge)"),
      width_pt:         z.number().optional().describe("Column width in points (set_column_width)"),
      height_pt:        z.number().optional().describe("Minimum row height in points (set_row_height)"),
      row_index:        z.number().int().optional().describe("0-based row index (set_row_height)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, document_id, table_start_index, row_start = 0, row_end = 1, col_start = 0, col_end = 1, width_pt, height_pt, row_index = 0 }) => {
      const { accessToken } = await getCreds();

      const tableCellLoc = {
        tableStartLocation: { index: table_start_index },
        rowIndex: row_start,
        columnIndex: col_start,
      };

      let req: any;
      if (action === "merge") {
        req = {
          mergeTableCells: {
            tableRange: {
              tableCellLocation: tableCellLoc,
              rowSpan: (row_end ?? row_start + 1) - row_start,
              columnSpan: (col_end ?? col_start + 1) - col_start,
            },
          },
        };
      } else if (action === "unmerge") {
        req = {
          unmergeTableCells: {
            tableRange: {
              tableCellLocation: tableCellLoc,
              rowSpan: (row_end ?? row_start + 1) - row_start,
              columnSpan: (col_end ?? col_start + 1) - col_start,
            },
          },
        };
      } else if (action === "set_column_width") {
        if (!width_pt) throw new Error("width_pt required");
        req = {
          updateTableColumnProperties: {
            tableStartLocation: { index: table_start_index },
            columnIndices: [col_start],
            tableColumnProperties: {
              widthType: "FIXED_WIDTH",
              width: { magnitude: width_pt, unit: "PT" },
            },
            fields: "widthType,width",
          },
        };
      } else if (action === "set_row_height") {
        if (!height_pt) throw new Error("height_pt required");
        req = {
          updateTableRowStyle: {
            tableStartLocation: { index: table_start_index },
            rowIndices: [row_index],
            tableRowStyle: { minRowHeight: { magnitude: height_pt, unit: "PT" } },
            fields: "minRowHeight",
          },
        };
      }

      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", { requests: [req] });
      return { content: [{ type: "text", text: `Table cell action "${action}" completed.` }] };
    }),
  );

  // ── insert_section_break ────────────────────────────────────────────────────

  server.tool("insert_section_break",
    "Insert a section break in a Google Doc (page break or continuous).",
    {
      document_id:  z.string(),
      index:        z.number().int().describe("Character index to insert at (from inspect_doc_structure)"),
      section_type: z.enum(["NEXT_PAGE","CONTINUOUS","EVEN_PAGE","ODD_PAGE"]).optional().default("NEXT_PAGE"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, index, section_type = "NEXT_PAGE" }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{
          insertSectionBreak: {
            location: { index },
            sectionType: section_type,
          },
        }],
      });
      return { content: [{ type: "text", text: `Section break (${section_type}) inserted at index ${index}.` }] };
    }),
  );

  // ── delete_paragraph_bullets ────────────────────────────────────────────────

  server.tool("delete_paragraph_bullets",
    "Remove bullet/list formatting from a range of paragraphs in a Google Doc. Preserves the text.",
    {
      document_id: z.string(),
      start_index: z.number().int().describe("Start character index of the range"),
      end_index:   z.number().int().describe("End character index of the range"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ document_id, start_index, end_index }) => {
      const { accessToken } = await getCreds();
      await docsRequest(accessToken, document_id, ":batchUpdate", "POST", {
        requests: [{
          deleteParagraphBullets: {
            range: { startIndex: start_index, endIndex: end_index },
          },
        }],
      });
      return { content: [{ type: "text", text: `Bullets removed from range [${start_index}, ${end_index}).` }] };
    }),
  );

} // end registerDocsPhase2Tools
