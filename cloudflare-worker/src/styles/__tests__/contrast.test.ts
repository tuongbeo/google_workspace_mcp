/**
 * styles/__tests__/contrast.test.ts
 * WCAG AA contrast validation for all 6 themes × Docs / Sheets / Slides
 *
 * Run:  NODE_ENV=development npx vitest run src/styles/__tests__/contrast.test.ts
 *
 * Rules:
 *   Normal text (< 18pt / 14pt bold) → ratio ≥ 4.5:1
 *   Large text  (≥ 18pt or ≥ 14pt bold) → ratio ≥ 3.0:1
 */

import { describe, it, expect } from "vitest";
import { THEMES } from "../key-colors";
import { FONT_PAIRS } from "../font-pairs";
import { deriveDocTokens } from "../derive-doc";
import { deriveSheetTokens } from "../derive-sheet";
import { deriveSlideTokens } from "../derive-slide";
import { contrastRatio } from "../contrast-utils";

const THEME_NAMES = ["corporate", "modern", "warm", "nature", "minimal", "vibrant"] as const;
const REF_FONT_PAIR = FONT_PAIRS.open_roboto;

// ─── Docs ──────────────────────────────────────────────────────────────────

describe("Docs contrast", () => {
  for (const themeName of THEME_NAMES) {
    const kc  = THEMES[themeName];
    const tok = deriveDocTokens(kc, REF_FONT_PAIR);

    describe(`Theme: ${themeName}`, () => {
      it("H1 vs white page ≥ 4.5:1", () => {
        const r = contrastRatio(tok.heading1.color, "#ffffff");
        expect(r, `H1 ${tok.heading1.color} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("H2 vs white page ≥ 4.5:1", () => {
        const r = contrastRatio(tok.heading2.color, "#ffffff");
        expect(r, `H2 ${tok.heading2.color} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("H3 vs white page ≥ 4.5:1", () => {
        const r = contrastRatio(tok.heading3.color, "#ffffff");
        expect(r, `H3 ${tok.heading3.color} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("H4 vs white page ≥ 4.5:1", () => {
        const r = contrastRatio(tok.heading4.color, "#ffffff");
        expect(r, `H4 ${tok.heading4.color} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Body text vs white page ≥ 4.5:1", () => {
        const r = contrastRatio(tok.normal.color, "#ffffff");
        expect(r, `body ${tok.normal.color} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Table header text vs header bg ≥ 4.5:1", () => {
        const r = contrastRatio(tok.tableHeader.textColor, tok.tableHeader.bgColor);
        expect(r, `tableHeader ${tok.tableHeader.textColor} vs ${tok.tableHeader.bgColor} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Body text vs table alt row bg ≥ 4.5:1", () => {
        const r = contrastRatio(tok.normal.color, tok.tableAltRow.bgColor);
        expect(r, `body ${tok.normal.color} vs altRow ${tok.tableAltRow.bgColor} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

// ─── Sheets ─────────────────────────────────────────────────────────────────

describe("Sheets contrast", () => {
  for (const themeName of THEME_NAMES) {
    const kc  = THEMES[themeName];
    const tok = deriveSheetTokens(kc, REF_FONT_PAIR);

    describe(`Theme: ${themeName}`, () => {
      it("Header text vs header bg ≥ 4.5:1", () => {
        const r = contrastRatio(tok.headerText, tok.headerBg);
        expect(r, `header ${tok.headerText} vs ${tok.headerBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Body text vs white row ≥ 4.5:1", () => {
        const r = contrastRatio(tok.bodyText, "#ffffff");
        expect(r, `body ${tok.bodyText} vs #fff = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Body text vs alt row bg ≥ 3.0:1", () => {
        const r = contrastRatio(tok.bodyText, tok.altRowBg);
        expect(r, `body ${tok.bodyText} vs altRow ${tok.altRowBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
      });
    });
  }
});

// ─── Slides ─────────────────────────────────────────────────────────────────

describe("Slides contrast", () => {
  for (const themeName of THEME_NAMES) {
    const kc  = THEMES[themeName];
    const tok = deriveSlideTokens(kc, REF_FONT_PAIR);

    describe(`Theme: ${themeName}`, () => {
      it("Cover title vs cover bg ≥ 4.5:1", () => {
        const r = contrastRatio(tok.coverTitle.color, tok.coverBg);
        expect(r, `coverTitle ${tok.coverTitle.color} vs ${tok.coverBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Cover subtitle vs cover bg ≥ 3.0:1 (large text)", () => {
        const r = contrastRatio(tok.coverSubtitle.color, tok.coverBg);
        expect(r, `subtitle ${tok.coverSubtitle.color} vs ${tok.coverBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
      });
      it("Section title vs section bg ≥ 4.5:1", () => {
        const r = contrastRatio(tok.sectionTitle.color, tok.sectionBg);
        expect(r, `sectionTitle ${tok.sectionTitle.color} vs ${tok.sectionBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Content title vs white slide ≥ 4.5:1", () => {
        const r = contrastRatio(tok.contentTitle.color, tok.defaultBg);
        expect(r, `contentTitle ${tok.contentTitle.color} vs ${tok.defaultBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
      it("Content body vs white slide ≥ 4.5:1", () => {
        const r = contrastRatio(tok.contentBody.color, tok.defaultBg);
        expect(r, `contentBody ${tok.contentBody.color} vs ${tok.defaultBg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

// ─── Cross font-pair spot check (corporate only) ────────────────────────────

describe("Font pair cross-check (corporate theme)", () => {
  const kc = THEMES.corporate;
  const pairs = ["open_roboto", "raleway_noto", "merriweather_open", "mulish_nunito"] as const;

  for (const pairName of pairs) {
    const fp = FONT_PAIRS[pairName];
    it(`Docs H1 corporate/${pairName} ≥ 4.5:1`, () => {
      const tok = deriveDocTokens(kc, fp);
      expect(contrastRatio(tok.heading1.color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    });
    it(`Sheets header corporate/${pairName} ≥ 4.5:1`, () => {
      const tok = deriveSheetTokens(kc, fp);
      expect(contrastRatio(tok.headerText, tok.headerBg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`Slides cover title corporate/${pairName} ≥ 4.5:1`, () => {
      const tok = deriveSlideTokens(kc, fp);
      expect(contrastRatio(tok.coverTitle.color, tok.coverBg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
