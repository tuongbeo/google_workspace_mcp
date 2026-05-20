/**
 * sheets-engine/executor.ts
 * 4-pass engine for write_google_sheet
 *
 * Pass 1 — Parse & detect column types  (parser.ts)
 * Pass 2 — Write data + number formats + smartchips
 * Pass 3 — Visual styling (banding, header, freeze, alignment, conditional)
 * Pass 4 — Rich elements (charts, overlay images)
  },
): Promise<void> {
  const { headers, rows, columns } = parsed;
  const nCols = headers.length;
  const nRows = rows.length;
  const totalRows = nRows + (opts.summary_row ? 1 : 0);

      const sheet = (info.sheets || []).find((s: any) => s.properties?.sheetId === sheetId);
      for (const br of (sheet?.bandedRanges || [])) {
        if (br.bandedRangeId) reqs.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
      }
    } catch { /* ignore */ }
    reqs.push({
      addBanding: {
        bandedRange: {
          range: gr(sheetId, 0, totalRows + 1, 0, nCols),
          rowProperties: {
            headerColor: rgb(tok.headerBg),
            firstBandColor: rgb("#ffffff"),
            secondBandColor: rgb(tok.altRowBg),
          },
        },
      },
    });
  }

  // Freeze
  if (opts.freeze_rows > 0) {
    reqs.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: opts.freeze_rows } },
        fields: "gridProperties.frozenRowCount",
      },
    });
  }
  if (opts.freeze_cols && opts.freeze_cols > 0) {
    reqs.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenColumnCount: opts.freeze_cols } },
        fields: "gridProperties.frozenColumnCount",
      },
    });
  }

  // Outer border
  const bdr = { style: "SOLID", color: rgb(tok.borderColor) };
  reqs.push({
    updateBorders: {
      range: gr(sheetId, 0, totalRows + 1, 0, nCols),
      top: bdr, bottom: bdr, left: bdr, right: bdr,
      innerHorizontal: bdr, innerVertical: bdr,
    },
  });

  if (reqs.length > 0) await batchUpdate(accessToken, spreadsheetId, reqs);
  const reqs2: any[] = [];

  // column_groups: merge + label header row
  if (opts.column_groups?.length) {
    let offset = 0;
    for (const cg of opts.column_groups) {
      if (cg.span > 1) {
        reqs2.push({ mergeCells: { range: gr(sheetId, 0, 1, offset, offset + cg.span), mergeType: "MERGE_ALL" } });
      }
      reqs2.push({
        repeatCell: {
          range: gr(sheetId, 0, 1, offset, offset + cg.span),
          cell: {
            userEnteredFormat: {
              backgroundColor: rgb(cg.color ?? tok.headerBg),
              textFormat: { bold: true, foregroundColor: rgb("#ffffff") },
              horizontalAlignment: "CENTER",
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        },
      });
      offset += cg.span;
    }
  }

  // total_rows
  if (opts.total_rows?.length && nRows > 0) {
    for (const rowIdx of opts.total_rows) {
      const ri = rowIdx + 1;
      reqs2.push({
        repeatCell: {
          range: gr(sheetId, ri, ri + 1, 0, nCols),
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      });
      reqs2.push({
        updateBorders: {
          range: gr(sheetId, ri, ri + 1, 0, nCols),
          top: { style: "SOLID_MEDIUM", color: rgb(tok.bodyText) },
        },
      });
    }
  }

  // Status dropdowns + conditional colors
  for (const col of columns) {
    const cfg = colConfigs[col.index];
    const type = (cfg?.type ?? col.type) as ColumnType;
    if (type === "status" && nRows > 0 && col.uniqueValues?.length) {
      reqs2.push({
        setDataValidation: {
          range: gr(sheetId, 1, nRows + 1, col.index, col.index + 1),
          rule: {
            condition: { type: "ONE_OF_LIST", values: col.uniqueValues.map(v => ({ userEnteredValue: v })) },
            strict: false, showCustomUi: true,
          },
        },
      });
      const sv = cfg?.status_values;
      if (sv) {
        for (const [val, colorKey] of Object.entries(sv)) {
          const bgHex = STATUS_COLORS[colorKey as string];
          if (bgHex) {
            reqs2.push({
              addConditionalFormatRule: {
                rule: {
                  ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
                  booleanRule: {
                    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: val }] },
                    format: { backgroundColor: rgb(bgHex) },
                  },
                },
                index: 0,
              },
            });
          }
        }
      }
    }
    // cell_colors
    if (cfg?.cell_colors && nRows > 0) {
      for (const [val, hexBg] of Object.entries(cfg.cell_colors)) {
        reqs2.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: val }] },
                format: { backgroundColor: rgb(hexBg) },
              },
            },
            index: 0,
          },
        });
      }
    }
  }

  // conditional_highlight
  if (opts.conditional_highlight && nRows > 0) {
    for (const col of columns) {
      const type = (colConfigs[col.index]?.type ?? col.type) as ColumnType;
      if (opts.conditional_highlight.negative_red
          && ["currency","integer","decimal"].includes(type)) {
        reqs2.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
              booleanRule: {
                condition: { type: "NUMBER_LESS", values: [{ userEnteredValue: "0" }] },
                format: { textFormat: { foregroundColor: rgb("#dc2626") } },
              },
            },
            index: 0,
          },
        });
      }
      if (opts.conditional_highlight.max_green
          && ["currency","integer","decimal","percent"].includes(type)) {
        const cA1 = colLetter(col.index);
        reqs2.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [gr(sheetId, 1, nRows + 1, col.index, col.index + 1)],
              booleanRule: {
                condition: {
                  type: "CUSTOM_FORMULA",
                  values: [{ userEnteredValue: `=${cA1}2=MAX($${cA1}$2:$${cA1}$${nRows + 1})` }],
                },
                format: { backgroundColor: rgb("#d1fae5") },
              },
            },
            index: 0,
          },
        });
      }
    }
  }

  // auto resize
  if (opts.auto_resize_columns) {
    reqs2.push({
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: nCols },
      },
    });
  }

  if (reqs2.length > 0) await batchUpdate(accessToken, spreadsheetId, reqs2);

  // section_headers: insertDimension descending to avoid index drift
  if (opts.section_headers?.length && nRows > 0) {
    const sorted = [...opts.section_headers].sort((a, b) => b.before_row - a.before_row);
    for (const sh of sorted) {
      const insertAt = sh.before_row + 1;
      if (insertAt < 1 || insertAt > nRows + 1) continue;
      await batchUpdate(accessToken, spreadsheetId, [{
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: insertAt, endIndex: insertAt + 1 },
          inheritFromBefore: false,
        },
      }]);
      const darkBg = kc.primaryDark;
      await batchUpdate(accessToken, spreadsheetId, [{
        repeatCell: {
          range: gr(sheetId, insertAt, insertAt + 1, 0, nCols),
          cell: {
            userEnteredFormat: {
              backgroundColor: rgb(darkBg),
              textFormat: { bold: true, foregroundColor: rgb("#ffffff"), fontSize: 10 },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      }]);
      // Write label text
      const labelRange = `${String.fromCharCode(65)}${insertAt + 1}`;
      await sheetsRequest(accessToken, spreadsheetId,
        `/values/${encodeURIComponent(labelRange)}?valueInputOption=RAW`, "PUT",
        { range: labelRange, values: [[sh.label]] });
    }
  }

  // summary_row
  if (opts.summary_row && nRows > 0) {
    const summaryRowIdx = nRows + 1;
    const summaryVals: any[] = parsed.headers.map((_, i) => {
      const type = (colConfigs[i]?.type ?? columns[i]?.type) as ColumnType;
      const cA1 = colLetter(i);
      if (["currency","integer","decimal"].includes(type))
        return `=SUM(${cA1}2:${cA1}${nRows + 1})`;
      if (type === "percent")
        return `=AVERAGE(${cA1}2:${cA1}${nRows + 1})`;
      if (i === 0) return "Total";
      return `=COUNTA(${cA1}2:${cA1}${nRows + 1})`;
    });
    const sRange = `A${summaryRowIdx + 1}:${colLetter(parsed.headers.length - 1)}${summaryRowIdx + 1}`;
    await sheetsRequest(accessToken, spreadsheetId,
      `/values/${encodeURIComponent(sRange)}?valueInputOption=USER_ENTERED`, "PUT",
      { range: sRange, values: [summaryVals] });
    await batchUpdate(accessToken, spreadsheetId, [
      {
        repeatCell: {
          range: gr(sheetId, summaryRowIdx, summaryRowIdx + 1, 0, parsed.headers.length),
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
      {
        updateBorders: {
          range: gr(sheetId, summaryRowIdx, summaryRowIdx + 1, 0, parsed.headers.length),
          top: { style: "SOLID_MEDIUM", color: rgb(tok.bodyText) },
        },
      },
    ]);
  }
}

// ─── PASS 4: charts + overlay images ─────────────────────────────────────────

async function pass4RichElements(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
  chart?: ChartConfig,
  overlayImages?: import("./types").OverlayImage[],
): Promise<void> {
  if (!chart && !overlayImages?.length) return;
  const reqs: any[] = [];

  if (chart) {
    const gRange = parseA1Range(chart.source_range, sheetId);
    const domainRange = { ...gRange, endColumnIndex: gRange.startColumnIndex + 1 };
    const anchor = chart.position?.anchor_cell
      ? parseAnchorCell(chart.position.anchor_cell)
      : { rowIndex: 1, columnIndex: 0 };
    const spec: any = { title: chart.title || "" };

    if (chart.type === "PIE") {
      spec.pieChart = {
        legendPosition: "RIGHT_LEGEND",
        domain: { sourceRange: { sources: [domainRange] } },
        series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } },
      };
    } else if (chart.type === "TIMELINE") {
      spec.basicChart = {
        chartType: "TIMELINE",
        headerCount: 1,
        domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
        series: [{
          series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } },
        }],
      };
    } else {
      const seriesList: any[] = [];
      for (let c = gRange.startColumnIndex + 1; c < gRange.endColumnIndex; c++) {
        seriesList.push({
          series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: c, endColumnIndex: c + 1 }] } },
        });
      }
      spec.basicChart = {
        chartType: chart.type,
        legendPosition: "BOTTOM_LEGEND",
        headerCount: 1,
        axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS" }],
        domains: [{ domain: { sourceRange: { sources: [domainRange] } } }],
        series: seriesList.length ? seriesList : [{
          series: { sourceRange: { sources: [{ ...gRange, startColumnIndex: gRange.startColumnIndex + 1 }] } },
        }],
      };
    }

    reqs.push({
      addChart: {
        chart: {
          spec,
          position: {
            overlayPosition: {
              anchorCell: { sheetId, rowIndex: anchor.rowIndex, columnIndex: anchor.columnIndex },
              widthPixels: 600, heightPixels: 400,
            },
          },
        },
      },
    });
  }

  if (overlayImages?.length) {
    for (const img of overlayImages) {
      const anchor = parseAnchorCell(img.anchor_cell);
      reqs.push({
        addEmbeddedImage: {
          embeddedImage: {
            image: { sourceUrl: img.url },
            position: {
              overlayPosition: {
                anchorCell: { sheetId, rowIndex: anchor.rowIndex, columnIndex: anchor.columnIndex },
                widthPixels: img.width, heightPixels: img.height,
              },
            },
          },
        },
      });
    }
  }

  if (reqs.length > 0) await batchUpdate(accessToken, spreadsheetId, reqs);
}

// ─── Single-sheet orchestrator ────────────────────────────────────────────────

async function processOneSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
  sheetName: string,
  sheetData: SheetData | WriteSheetInput,
): Promise<{ rows: number; cols: number }> {
  const colConfigs: Record<number, ColumnConfig> = {};
  for (const [k, v] of Object.entries(sheetData.columns ?? {})) {
    colConfigs[parseInt(k)] = v as ColumnConfig;
  }
  const parsed = parseInput(sheetData, colConfigs);
  const theme = (sheetData.theme ?? "corporate") as ThemeName;
  const position = sheetData.position ?? "replace";

  await pass2DataWrite(accessToken, spreadsheetId, sheetId, sheetName, parsed, colConfigs, position);
  await pass3Styling(accessToken, spreadsheetId, sheetId, parsed, colConfigs, {
    theme,
    alternating_rows: sheetData.alternating_rows ?? true,
    freeze_rows: sheetData.freeze_rows ?? 1,
    freeze_cols: sheetData.freeze_cols,
    auto_resize_columns: sheetData.auto_resize_columns ?? true,
    column_groups: sheetData.column_groups,
    section_headers: sheetData.section_headers,
    total_rows: sheetData.total_rows,
    summary_row: sheetData.summary_row,
    conditional_highlight: sheetData.conditional_highlight,
    conditional_rules: sheetData.conditional_rules,
  });
  await pass4RichElements(accessToken, spreadsheetId, sheetId, sheetData.chart, sheetData.overlay_images);
  return { rows: parsed.rows.length, cols: parsed.headers.length };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function executeWriteSheet(
  accessToken: string,
  input: WriteSheetInput,
): Promise<{ spreadsheetId: string; url: string; summary: string[] }> {
  const isCreate = !input.spreadsheet_id;

  // Resolve the list of sheets to process
  const sheetsList: SheetData[] = input.sheets?.length
    ? input.sheets
    : [{ name: input.sheet_name ?? "Sheet1", ...input } as SheetData];

  let spreadsheetId: string;
  let createdSheets: any[];

  if (isCreate) {
    if (!input.name) throw new Error("Parameter 'name' required when creating new spreadsheet");
    const result = await googleFetch(
      "https://sheets.googleapis.com/v4/spreadsheets", accessToken, "POST",
      {
        properties: { title: input.name },
        sheets: sheetsList.map((s, i) => ({ properties: { title: s.name, index: i } })),
      },
    ) as any;
    spreadsheetId = result.spreadsheetId;
    createdSheets = result.sheets;
  } else {
    spreadsheetId = input.spreadsheet_id!;
    const info = await sheetsRequest(accessToken, spreadsheetId,
      "?fields=sheets(properties(sheetId,title))") as any;
    createdSheets = info.sheets || [];
    // Ensure target tabs exist
    for (const s of sheetsList) {
      const exists = createdSheets.find((sh: any) => sh.properties?.title === s.name);
      if (!exists) {
        const r = await batchUpdate(accessToken, spreadsheetId,
          [{ addSheet: { properties: { title: s.name } } }]) as any;
        createdSheets.push(r.replies?.[0]?.addSheet);
      }
    }
  }

  const summary: string[] = [];
  for (const sheetDef of sheetsList) {
    const meta = createdSheets.find((s: any) => s.properties?.title === sheetDef.name);
    const sheetId: number = meta?.properties?.sheetId ?? 0;

    // Inherit top-level input fields if sheet doesn't define its own
    const merged: SheetData = {
      ...sheetDef,
      data: sheetDef.data ?? (input.data as any),
      csv: sheetDef.csv ?? input.csv,
      markdown_table: sheetDef.markdown_table ?? input.markdown_table,
      columns: sheetDef.columns ?? input.columns,
      theme: sheetDef.theme ?? input.theme,
      alternating_rows: sheetDef.alternating_rows ?? input.alternating_rows,
      freeze_rows: sheetDef.freeze_rows ?? input.freeze_rows,
      freeze_cols: sheetDef.freeze_cols ?? input.freeze_cols,
      auto_resize_columns: sheetDef.auto_resize_columns ?? input.auto_resize_columns,
      summary_row: sheetDef.summary_row ?? input.summary_row,
      conditional_highlight: sheetDef.conditional_highlight ?? input.conditional_highlight,
      chart: sheetDef.chart ?? input.chart,
      position: sheetDef.position ?? input.position,
    };

    const { rows, cols } = await processOneSheet(
      accessToken, spreadsheetId, sheetId, sheetDef.name, merged,
    );
    summary.push(`  • "${sheetDef.name}": ${cols} cols × ${rows} rows`);
  }

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    summary,
  };
}
