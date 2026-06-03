/**
 * Derive Google Docs styling tokens from KeyColors
 * Used by create_rich_doc, import_to_google_doc
 */

import { KeyColors } from "./key-colors";
import { FontPair } from "./font-pairs";

export interface DocTokens {
  // Named styles (updateNamedStyle)
  heading1: { color: string; fontSize: number; bold: boolean; fontFamily: string };
  heading2: { color: string; fontSize: number; bold: boolean; fontFamily: string };
  heading3: { color: string; fontSize: number; bold: boolean; fontFamily: string };
  heading4: { color: string; fontSize: number; bold: boolean; fontFamily: string };
  normal:   { color: string; fontSize: number; fontFamily: string };
  // Table
  tableHeader: { bgColor: string; textColor: string; bold: boolean };
  tableAltRow: { bgColor: string };
  // Spacing
  pageMarginPt: number;
}

export function deriveDocTokens(colors: KeyColors, fonts: FontPair): DocTokens {
  return {
    // Font sizes aligned with Google Docs Named Style defaults:
    // H1=20pt, H2=16pt, H3=13pt(bold), H4=11pt(bold) — differentiated by color
    heading1: { color: colors.primary,     fontSize: 20, bold: true,  fontFamily: fonts.heading },
    heading2: { color: colors.primary,     fontSize: 16, bold: true,  fontFamily: fonts.heading },
    heading3: { color: colors.primaryDark, fontSize: 13, bold: true,  fontFamily: fonts.heading },
    heading4: { color: colors.textMuted,   fontSize: 11, bold: true,  fontFamily: fonts.heading },
    normal:   { color: colors.text,        fontSize: 11, fontFamily: fonts.body },
    tableHeader: {
      bgColor:   colors.primary,
      textColor: "#ffffff",
      bold:      true,
    },
    tableAltRow: {
      bgColor: colors.primaryLight,
    },
    pageMarginPt: 72, // 1 inch
  };
}
