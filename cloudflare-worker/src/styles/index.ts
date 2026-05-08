/**
 * Barrel export for src/styles/ module
 */

export { THEMES, getTheme, type KeyColors, type ThemeName } from "./key-colors";
export { FONT_PAIRS, getFontPair, type FontPair, type FontPairName } from "./font-pairs";
export { deriveDocTokens, type DocTokens } from "./derive-doc";
export { deriveSheetTokens, hexToSheetsRgb, type SheetTokens } from "./derive-sheet";
export { deriveSlideTokens, hexToSlidesRgb, ptToEmu, inchesToEmu, type SlideTokens } from "./derive-slide";
export { contrastRatio, meetsWCAG_AA, validateContrast, type ContrastViolation } from "./contrast-utils";
