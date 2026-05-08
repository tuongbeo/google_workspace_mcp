/**
 * WCAG contrast ratio utilities
 * Standard: AA requires 4.5:1 for normal text, 3:1 for large text
 */

/** Parse hex color (#RRGGBB or #RGB) to [r, g, b] 0-255 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Relative luminance per WCAG 2.1 */
function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Contrast ratio between two hex colors */
export function contrastRatio(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const L1 = luminance(r1, g1, b1);
  const L2 = luminance(r2, g2, b2);
  const lighter = Math.max(L1, L2);
  const darker  = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Check WCAG AA (4.5:1 for normal text) */
export function meetsWCAG_AA(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 4.5;
}

export interface ContrastViolation {
  fg: string;
  bg: string;
  ratio: number;
  label: string;
}

/** Validate a set of color pairs, return violations */
export function validateContrast(
  pairs: Array<{ fg: string; bg: string; label: string }>
): ContrastViolation[] {
  return pairs
    .map(p => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }))
    .filter(p => p.ratio < 4.5);
}
