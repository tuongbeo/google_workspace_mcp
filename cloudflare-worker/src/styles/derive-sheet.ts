/**
 * Derive Google Sheets styling tokens from KeyColors
 */

import { KeyColors } from "./key-colors";
import { FontPair } from "./font-pairs";

export interface SheetTokens {
  headerBg:       string;
  headerText:     string;
  headerBold:     boolean;
  headerFontSize: number;
  altRowBg:       string;
  bodyText:       string;
  bodyFontSize:   number;
  borderColor:    string;
  fontFamily:     string;
  frozenRows:     number;
}

export function deriveSheetTokens(colors: KeyColors, fonts: FontPair): SheetTokens {
  return {
    headerBg:       colors.primary,
    headerText:     "#ffffff",
    headerBold:     true,
    headerFontSize: 11,
    altRowBg:       colors.primaryLight,
    bodyText:       colors.text,
    bodyFontSize:   10,
    borderColor:    colors.border,
    fontFamily:     fonts.body,
    frozenRows:     1,
  };
}

/** Convert hex (#RRGGBB) to Sheets API RGB object (0-1 floats) */
export function hexToSheetsRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "");
  return {
    red:   parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue:  parseInt(h.slice(4, 6), 16) / 255,
  };
}
