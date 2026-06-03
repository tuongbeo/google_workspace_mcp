/**
 * Derive Google Slides styling tokens from KeyColors
 * All sizes in EMU (1 inch = 914400, 1 pt = 12700)
 */

import { KeyColors } from "./key-colors";
import { FontPair } from "./font-pairs";

export interface SlideTokens {
  // Cover slide
  coverBg:         string;
  coverTitle:      { color: string; fontSize: number; bold: boolean; fontFamily: string };
  coverSubtitle:   { color: string; fontSize: number; fontFamily: string };
  // Section header
  sectionBg:       string;
  sectionTitle:    { color: string; fontSize: number; bold: boolean; fontFamily: string };
  // Content
  contentTitle:    { color: string; fontSize: number; bold: boolean; fontFamily: string };
  contentBody:     { color: string; fontSize: number; fontFamily: string };
  // Accent
  accentColor:     string;
  // Background
  defaultBg:       string;
}

export function deriveSlideTokens(colors: KeyColors, fonts: FontPair): SlideTokens {
  return {
    // Font sizes aligned with Google Slides predefined layout defaults:
    // coverTitle=36pt (Title placeholder), sectionTitle=28pt (Section Header layout),
    // contentTitle=22pt (Title and Body layout), contentBody=15pt (body placeholder)
    coverBg:         colors.primaryDark,
    coverTitle: {
      color:      "#ffffff",
      fontSize:   36,
      bold:       true,
      fontFamily: fonts.heading,
    },
    coverSubtitle: {
      color:      colors.primaryLight,
      fontSize:   18,
      fontFamily: fonts.body,
    },
    sectionBg:      colors.primary,
    sectionTitle: {
      color:      "#ffffff",
      fontSize:   28,
      bold:       true,
      fontFamily: fonts.heading,
    },
    contentTitle: {
      color:      colors.primary,
      fontSize:   22,
      bold:       true,
      fontFamily: fonts.heading,
    },
    contentBody: {
      color:      colors.text,
      fontSize:   15,
      fontFamily: fonts.body,
    },
    accentColor:  colors.primary,
    defaultBg:    "#ffffff",
  };
}

/** Convert hex (#RRGGBB) to Slides API RgbColor (0-1 floats) */
export function hexToSlidesRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "");
  return {
    red:   parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue:  parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Convert pt to EMU */
export function ptToEmu(pt: number): number {
  return Math.round(pt * 12700);
}

/** Convert inches to EMU */
export function inchesToEmu(inches: number): number {
  return Math.round(inches * 914400);
}
