/**
 * sheets-engine/parser.ts
<<<<<<< HEAD
 * Parse CSV / JSON / Markdown table → ParsedSheet
=======
 * Parse CSV / JSON / Markdown table -> ParsedSheet
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
 * Auto-detect column types from header keywords + value patterns
 */

import { ColumnType, ParsedSheet, ParsedColumn, SheetData } from "./types";

<<<<<<< HEAD
// ─── CSV parser ───────────────────────────────────────────────────────────────

=======
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
function parseCSV(csv: string): (string | number | boolean | null)[][] {
  const rows: string[][] = [];
  const lines = csv.trim().split(/\r?\n/);
  for (const line of lines) {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cells.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

<<<<<<< HEAD
// ─── Markdown table parser ────────────────────────────────────────────────────

=======
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
function parseMarkdownTable(md: string): string[][] {
  return md.trim().split(/\r?\n/)
    .filter(l => l.trim().startsWith("|"))
    .filter(l => !l.match(/^\|[\s|:-]+\|$/))
    .map(l => l.split("|").slice(1, -1).map(cell => cell.trim()));
}

<<<<<<< HEAD
// ─── Type detection helpers ───────────────────────────────────────────────────

const CURRENCY_HEADERS = /revenue|price|cost|amount|fee|salary|budget|sales|profit|income|spend|total/i;
const PERCENT_HEADERS  = /rate|ratio|growth|pct|percent|margin|share|utiliz/i;
const DATE_HEADERS     = /date|month|year|period|quarter|week|day|time|created|updated|due/i;
const OWNER_HEADERS    = /owner|assignee|author|contact|reporter|user|person|member|lead/i;
const BOOL_SET = new Set(["true","false","yes","no","0","1","active","inactive","on","off","✓","✗"]);

function isNumericStr(v: string): boolean {
  return v !== "" && !isNaN(Number(v.replace(/[$,%]/g, "")));
}
function isIntegerStr(v: string): boolean {
  const n = Number(v.replace(/[$,%]/g, ""));
  return Number.isInteger(n);
}
function isISODate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v);
}
function isDriveUrl(v: string): boolean {
  return /docs\.google\.com|drive\.google\.com/.test(v);
}
function isImageUrl(v: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)(\?|$)/i.test(v);
}

export function detectColumnType(
  header: string,
  values: (string | number | boolean | null)[],
): ColumnType {
  const nonNull = values.filter(v => v !== null && v !== "");
  if (nonNull.length === 0) return "text";
  const strVals = nonNull.map(v => String(v));

  // People chip
  if (OWNER_HEADERS.test(header) && strVals.some(v => v.includes("@"))) return "people_chip";
  if (strVals.every(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "people_chip";

  // File chip
  if (strVals.some(v => isDriveUrl(v))) return "file_chip";

  // Image formula
  if (strVals.some(v => isImageUrl(v))) return "image_formula";

  // Boolean
  if (strVals.map(v => v.toLowerCase()).every(v => BOOL_SET.has(v))) return "boolean";

  // Date
  if (DATE_HEADERS.test(header) || strVals.every(v => isISODate(v))) return "date";

  // Numeric
  const allNumeric = strVals.every(v => isNumericStr(v.replace(/[$,%]/g, "")));
  if (allNumeric) {
    if (CURRENCY_HEADERS.test(header) || strVals.some(v => v.startsWith("$"))) return "currency";
    if (PERCENT_HEADERS.test(header) || strVals.some(v => v.endsWith("%"))) return "percent";
    const nums = strVals.map(v => Number(v.replace(/[$,%]/g, "")));
    if (nums.every(n => n >= 0 && n <= 1)) return "percent";
    return strVals.every(v => isIntegerStr(v)) ? "integer" : "decimal";
  }

  // Status: ≤8 unique string values
  const unique = new Set(strVals);
  if (unique.size <= 8) return "status";

=======
const CURRENCY_HDR = /revenue|price|cost|amount|fee|salary|budget|sales|profit|income|spend|total/i;
const PERCENT_HDR  = /rate|ratio|growth|pct|percent|margin|share|utiliz/i;
const DATE_HDR     = /date|month|year|period|quarter|week|day|time|created|updated|due/i;
const OWNER_HDR    = /owner|assignee|author|contact|reporter|user|person|member|lead/i;
const BOOL_SET = new Set(["true","false","yes","no","0","1","active","inactive","on","off","✓","✗"]);

function isNumStr(v: string): boolean { return v !== "" && !isNaN(Number(v.replace(/[$,%]/g, ""))); }
function isIntStr(v: string): boolean { return Number.isInteger(Number(v.replace(/[$,%]/g, ""))); }
function isISODate(v: string): boolean { return /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v); }
function isDriveUrl(v: string): boolean { return /docs\.google\.com|drive\.google\.com/.test(v); }
function isImageUrl(v: string): boolean { return /\.(png|jpg|jpeg|gif|svg|webp)(\?|$)/i.test(v); }

export function detectColumnType(header: string, values: (string | number | boolean | null)[]): ColumnType {
  const nonNull = values.filter(v => v !== null && v !== "");
  if (nonNull.length === 0) return "text";
  const sv = nonNull.map(v => String(v));
  if (OWNER_HDR.test(header) && sv.some(v => v.includes("@"))) return "people_chip";
  if (sv.every(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "people_chip";
  if (sv.some(v => isDriveUrl(v))) return "file_chip";
  if (sv.some(v => isImageUrl(v))) return "image_formula";
  if (sv.map(v => v.toLowerCase()).every(v => BOOL_SET.has(v))) return "boolean";
  if (DATE_HDR.test(header) || sv.every(v => isISODate(v))) return "date";
  const allNum = sv.every(v => isNumStr(v.replace(/[$,%]/g, "")));
  if (allNum) {
    if (CURRENCY_HDR.test(header) || sv.some(v => v.startsWith("$"))) return "currency";
    if (PERCENT_HDR.test(header) || sv.some(v => v.endsWith("%"))) return "percent";
    const nums = sv.map(v => Number(v.replace(/[$,%]/g, "")));
    if (nums.every(n => n >= 0 && n <= 1)) return "percent";
    return sv.every(v => isIntStr(v)) ? "integer" : "decimal";
  }
  // Status: ≤8 unique values AND all values are short strings (max 40 chars)
  if (new Set(sv).size <= 8 && sv.every(v => v.length <= 40)) return "status";
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
  return "text";
}

export function buildNumberFormat(type: ColumnType, override?: string): string | null {
  if (override) return override;
  switch (type) {
<<<<<<< HEAD
    case "currency": return '"$"#,##0.00';
=======
    case "currency": return '"\$"#,##0.00';
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
    case "percent":  return "0.0%";
    case "integer":  return "#,##0";
    case "decimal":  return "#,##0.00";
    case "date":     return "MMM d, yyyy";
    default: return null;
  }
}

<<<<<<< HEAD
// ─── Main entry ───────────────────────────────────────────────────────────────

=======
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
export function parseInput(
  input: Pick<SheetData, "data" | "csv" | "markdown_table">,
  columnOverrides?: Record<number, { type?: ColumnType; format?: string }>,
): ParsedSheet {
  let raw: (string | number | boolean | null)[][];
<<<<<<< HEAD

  if (input.data) {
    raw = [input.data.headers as any[], ...input.data.rows];
  } else if (input.csv) {
    raw = parseCSV(input.csv);
  } else if (input.markdown_table) {
    raw = parseMarkdownTable(input.markdown_table);
  } else {
    throw new Error("Provide exactly one of: data, csv, markdown_table");
  }

  if (raw.length < 1) throw new Error("No data rows found in input");

  const headers = raw[0].map(h => String(h ?? ""));
  const rows = raw.slice(1);

=======
  if (input.data) { raw = [input.data.headers as any[], ...input.data.rows]; }
  else if (input.csv) { raw = parseCSV(input.csv); }
  else if (input.markdown_table) { raw = parseMarkdownTable(input.markdown_table); }
  else { throw new Error("Provide exactly one of: data, csv, markdown_table"); }
  if (raw.length < 1) throw new Error("No data rows found in input");
  const headers = raw[0].map(h => String(h ?? ""));
  const rows = raw.slice(1);
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
  const columns: ParsedColumn[] = headers.map((header, i) => {
    const values = rows.map(r => r[i] ?? null);
    const override = columnOverrides?.[i];
    const type = override?.type ?? detectColumnType(header, values);
<<<<<<< HEAD
    const strVals = values
      .filter(v => v !== null && v !== "")
      .map(v => String(v));
    const unique = type === "status" ? [...new Set(strVals)] : undefined;
    return { index: i, header, type, values, uniqueValues: unique };
  });

=======
    const strVals = values.filter(v => v !== null && v !== "").map(v => String(v));
    const unique = type === "status" ? [...new Set(strVals)] : undefined;
    return { index: i, header, type, values, uniqueValues: unique };
  });
>>>>>>> ae99365fc858c6dca0a7eafa6bd540cd59622958
  return { headers, rows, columns };
}
