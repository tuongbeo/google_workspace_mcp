/**
 * sheets-engine/types.ts
 * Type definitions for write_google_sheet engine
 */

export type ColumnType =
  | "currency" | "percent" | "integer" | "decimal"
  | "date" | "boolean" | "text" | "status"
  | "people_chip" | "file_chip" | "image_formula";

export type ThemeName = "corporate" | "modern" | "warm" | "nature" | "minimal" | "vibrant";

export interface ColumnConfig {
  type?: ColumnType;
  status_values?: Record<string, "green" | "amber" | "red" | "blue" | "gray">;
  cell_colors?: Record<string, string>;
  width?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  format?: string;
}

export interface ColumnGroup {
  label: string;
  span: number;
  color?: string;
}

export interface SectionHeader {
  before_row: number;
  label: string;
  indent_rows?: boolean;
}

export interface ChartConfig {
  type: "BAR" | "LINE" | "PIE" | "COLUMN" | "AREA" | "SCATTER" | "TIMELINE";
  source_range: string;
  title?: string;
  position?: { anchor_cell: string };
}

export interface OverlayImage {
  url: string;
  anchor_cell: string;
  width: number;
  height: number;
}

export interface SheetData {
  name: string;
  data?: { headers: string[]; rows: (string | number | boolean | null)[][] };
  csv?: string;
  markdown_table?: string;
  column_groups?: ColumnGroup[];
  section_headers?: SectionHeader[];
  total_rows?: number[];
  columns?: Record<number, ColumnConfig>;
  theme?: ThemeName;
  alternating_rows?: boolean;
  freeze_rows?: number;
  freeze_cols?: number;
  auto_resize_columns?: boolean;
  summary_row?: boolean;
  conditional_highlight?: { negative_red?: boolean; max_green?: boolean };
  conditional_rules?: Array<{ range: string; condition: object; format: object }>;
  chart?: ChartConfig;
  overlay_images?: OverlayImage[];
  position?: "replace" | "append";
}

export interface WriteSheetInput extends Omit<SheetData, "name"> {
  name?: string;
  spreadsheet_id?: string;
  sheets?: SheetData[];
  sheet_name?: string;
}

export interface ParsedColumn {
  index: number;
  header: string;
  type: ColumnType;
  values: (string | number | boolean | null)[];
  uniqueValues?: string[];
}

export interface ParsedSheet {
  headers: string[];
  rows: (string | number | boolean | null)[][];
  columns: ParsedColumn[];
}
