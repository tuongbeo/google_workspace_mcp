/**
 * 6 themes × 9 key colors (verified Tailwind v4 hex values)
 * Usage: import { THEMES, ThemeName } from "./key-colors"
 */

export interface KeyColors {
  primary:      string; // Main brand color (headings, buttons, accents)
  primaryDark:  string; // Darkened primary for backgrounds/contrast
  primaryLight: string; // Light tint for backgrounds, alt rows
  text:         string; // Default body text
  textMuted:    string; // Secondary / caption text
  border:       string; // Dividers, table borders, rule lines
  success:      string; // Positive status
  warning:      string; // Caution status
  error:        string; // Error / danger status
}

export type ThemeName = "corporate" | "modern" | "warm" | "nature" | "minimal" | "vibrant"
  | "blue" | "green" | "purple" | "orange"; // legacy aliases

export const THEMES: Record<string, KeyColors> = {
  corporate: {
    primary:      "#1e40af", // blue-800
    primaryDark:  "#1e293b", // slate-800
    primaryLight: "#dbeafe", // blue-100
    text:         "#1e293b", // slate-800
    textMuted:    "#64748b", // slate-500
    border:       "#cbd5e1", // slate-300
    success:      "#15803d", // green-700
    warning:      "#a16207", // yellow-700
    error:        "#b91c1c", // red-700
  },
  modern: {
    primary:      "#4f46e5", // indigo-600
    primaryDark:  "#27272a", // zinc-800
    primaryLight: "#eef2ff", // indigo-50
    text:         "#27272a", // zinc-800
    textMuted:    "#71717a", // zinc-500
    border:       "#d4d4d8", // zinc-300
    success:      "#059669", // emerald-600
    warning:      "#d97706", // amber-600
    error:        "#e11d48", // rose-600
  },
  warm: {
    primary:      "#b45309", // amber-700
    primaryDark:  "#1c1917", // stone-800
    primaryLight: "#fffbeb", // amber-50
    text:         "#1c1917", // stone-800
    textMuted:    "#78716c", // stone-500
    border:       "#d6d3d1", // stone-300
    success:      "#15803d", // green-700
    warning:      "#ea580c", // orange-600
    error:        "#b91c1c", // red-700
  },
  nature: {
    primary:      "#047857", // emerald-700
    primaryDark:  "#171717", // neutral-800
    primaryLight: "#ecfdf5", // emerald-50
    text:         "#171717", // neutral-800
    textMuted:    "#737373", // neutral-500
    border:       "#d4d4d4", // neutral-300
    success:      "#0d9488", // teal-600
    warning:      "#ca8a04", // yellow-600
    error:        "#dc2626", // red-600
  },
  minimal: {
    primary:      "#4b5563", // gray-600
    primaryDark:  "#1f2937", // gray-800
    primaryLight: "#f9fafb", // gray-50
    text:         "#1f2937", // gray-800
    textMuted:    "#6b7280", // gray-500
    border:       "#d1d5db", // gray-300
    success:      "#16a34a", // green-600
    warning:      "#d97706", // amber-600
    error:        "#dc2626", // red-600
  },
  vibrant: {
    primary:      "#7c3aed", // violet-600
    primaryDark:  "#0f172a", // slate-900
    primaryLight: "#f5f3ff", // violet-50
    text:         "#1e293b", // slate-800
    textMuted:    "#64748b", // slate-500
    border:       "#cbd5e1", // slate-300
    success:      "#10b981", // emerald-500
    warning:      "#f59e0b", // amber-500
    error:        "#f43f5e", // rose-500
  },
};

// Legacy aliases — backward compat
THEMES.blue   = THEMES.corporate;
THEMES.green  = THEMES.nature;
THEMES.purple = THEMES.vibrant;
THEMES.orange = THEMES.warm;

export function getTheme(name?: string): KeyColors {
  return THEMES[name || "corporate"] ?? THEMES.corporate;
}
