/**
 * Font pair definitions for Google Workspace docs/slides
 *
 * All fonts are:
 * - Free on Google Fonts
 * - Available via Google Docs/Sheets/Slides API
 * - Vietnamese-capable (Latin Extended + diacritics)
 *
 * Removed: Arial (too generic), Inter (overused AI aesthetic),
 *          Georgia/Source Sans Pro (poor Vietnamese diacritics),
 *          Proxima Nova (commercial), Be Vietnam Pro (unverified API availability)
 */

export interface FontPair {
  heading: string;
  body:    string;
  useCase: string;
}

export type FontPairName =
  | "open_roboto"
  | "raleway_noto"
  | "merriweather_open"
  | "mulish_nunito";

export const FONT_PAIRS: Record<FontPairName, FontPair> = {
  // Default: clean, professional, excellent Vietnamese support
  open_roboto: {
    heading: "Open Sans",
    body:    "Roboto",
    useCase: "Business documents, default, excellent Vietnamese",
  },
  // Elegant display: Raleway (Vietnamese support since v4.0, by Vietnamese designer)
  raleway_noto: {
    heading: "Raleway",
    body:    "Noto Sans",
    useCase: "Elegant headings, maximum Unicode/Vietnamese coverage",
  },
  // Editorial: classic serif + clean sans
  merriweather_open: {
    heading: "Merriweather",
    body:    "Open Sans",
    useCase: "Long-form documents, editorial",
  },
  // Friendly: modern rounded, good for presentations
  mulish_nunito: {
    heading: "Mulish",
    body:    "Nunito",
    useCase: "Presentations, friendly tone",
  },
};

export function getFontPair(name?: string): FontPair {
  return FONT_PAIRS[(name as FontPairName) || "open_roboto"] ?? FONT_PAIRS.open_roboto;
}
