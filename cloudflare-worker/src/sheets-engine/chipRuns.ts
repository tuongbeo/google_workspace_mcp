/**
 * sheets-engine/chipRuns.ts
 * Build Sheets API chipRuns for people + file smart chips
 */

export function buildPersonChipCell(email: string): object {
  return {
    userEnteredValue: { stringValue: "@" },
    chipRuns: [{ startIndex: 0, endIndex: 1, format: { personProperties: { email } } }],
  };
}

export function buildFileChipCell(uri: string): object {
  return {
    userEnteredValue: { stringValue: "@" },
    chipRuns: [{ startIndex: 0, endIndex: 1, format: { richLinkProperties: { uri } } }],
  };
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isDriveUrl(v: string): boolean {
  return /docs\.google\.com|drive\.google\.com/.test(v);
}
