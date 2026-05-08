/**
 * Font pair definitions for Google Workspace docs/slides
 */

export interface FontPair {
  heading: string;
  body:    string;
  useCase: string;
}

export type FontPairName = "arial_roboto" | "georgia_source" | "inter_system" | "merriweather_open";

export const FONT_PAIRS: Record<FontPairName, FontPair> = {
  arial_roboto: {
    heading: "Arial",
    body:    "Roboto",
    useCase: "Corporate default",
  },
  georgia_source: {
    heading: "Georgia",
    body:    "Source Sans Pro",
    useCase: "Editorial",
  },
  inter_system: {
    heading: "Inter",
    body:    "Inter",
    useCase: "Modern clean",
  },
  merriweather_open: {
    heading: "Merriweather",
    body:    "Open Sans",
    useCase: "Long-form",
  },
};

export function getFontPair(name?: string): FontPair {
  return FONT_PAIRS[(name as FontPairName) || "arial_roboto"] ?? FONT_PAIRS.arial_roboto;
}
