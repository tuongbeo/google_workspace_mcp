/**
 * Google Slides MCP Tools — Extended functionality
 * Covers: slide management, text/shape ops, images, tables, formatting, speaker notes
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch, slidesRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerSlidesExtendedTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("duplicate_slide", "Duplicate an existing slide in a Google Slides presentation. Returns the new slide object ID.", {
    presentation_id: z.string(),
    slide_object_id: z.string().describe("Object ID of the slide to duplicate (from get_presentation)"),
    insertion_index: z.number().optional().describe("0-based index where the duplicate is inserted. Omit to insert after original."),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, insertion_index }) => {
    const { accessToken } = await getCreds();
    const req: any = { duplicateObject: { objectId: slide_object_id } };
    if (insertion_index !== undefined) {
      req.duplicateObject.objectIds = { [slide_object_id]: `${slide_object_id}_copy_${Date.now()}` };
    }
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [req] }) as any;
    const newId = result.replies?.[0]?.duplicateObject?.objectId;
    return { content: [{ type: "text", text: `Slide duplicated.\nOriginal ID: ${slide_object_id}\nNew slide ID: ${newId || "unknown"}` }] };
  }));

  server.tool("reorder_slides", "Move slides to a new position in the presentation.", {
    presentation_id: z.string(),
    slide_object_ids: z.array(z.string()).describe("Object IDs of slides to move (in desired relative order)"),
    insertion_index: z.number().describe("0-based index in the presentation where slides will be moved to"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_ids, insertion_index }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ updateSlidesPosition: { slideObjectIds: slide_object_ids, insertionIndex: insertion_index } }],
    });
    return { content: [{ type: "text", text: `Slides moved to position ${insertion_index}.\nMoved: ${slide_object_ids.join(", ")}` }] };
  }));

  server.tool("update_slide_background", "Set the background color of a slide.", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    red: z.number().min(0).max(1).describe("Red (0–1)"),
    green: z.number().min(0).max(1).describe("Green (0–1)"),
    blue: z.number().min(0).max(1).describe("Blue (0–1)"),
    alpha: z.number().min(0).max(1).optional().default(1),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, red, green, blue, alpha = 1 }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ updatePageProperties: { objectId: slide_object_id, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: { red, green, blue } }, alpha } } }, fields: "pageBackgroundFill" } }],
    });
    return { content: [{ type: "text", text: `Slide background updated!\nSlide: ${slide_object_id}\nColor: rgb(${Math.round(red*255)}, ${Math.round(green*255)}, ${Math.round(blue*255)})` }] };
  }));

  server.tool("get_slide_notes", "Read the speaker notes of a specific slide.", {
    presentation_id: z.string(),
    slide_object_id: z.string().describe("Slide object ID (from get_presentation)"),
  }, withErrorHandler(async ({ presentation_id, slide_object_id }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as any;
    const slide = (data.slides || []).find((s: any) => s.objectId === slide_object_id);
    if (!slide) return { content: [{ type: "text", text: `Slide not found: ${slide_object_id}` }] };
    const notes = slide.slideProperties?.notesPage;
    const notesTexts = (notes?.pageElements || []).flatMap((el: any) => el.shape?.text?.textElements || []).map((te: any) => te.textRun?.content || "").join("").trim();
    return { content: [{ type: "text", text: notesTexts ? `Speaker notes:\n${notesTexts}` : "No speaker notes on this slide." }] };
  }));

  server.tool("set_slide_notes", "Set (replace) the speaker notes on a slide.", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    notes_text: z.string().describe("Text content for speaker notes"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, notes_text }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as any;
    const slide = (data.slides || []).find((s: any) => s.objectId === slide_object_id);
    if (!slide) return { content: [{ type: "text", text: `Slide not found: ${slide_object_id}` }] };
    const notesPage = slide.slideProperties?.notesPage;
    const notesShapeId = (notesPage?.pageElements || []).find((el: any) => el.shape?.placeholder?.type === "BODY")?.objectId;
    if (!notesShapeId) return { content: [{ type: "text", text: `No notes shape found on slide ${slide_object_id}` }] };
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [
        { deleteText: { objectId: notesShapeId, textRange: { type: "ALL" } } },
        { insertText: { objectId: notesShapeId, insertionIndex: 0, text: notes_text } },
      ],
    });
    return { content: [{ type: "text", text: `Speaker notes updated!\nSlide: ${slide_object_id}\nNotes: ${notes_text.substring(0, 100)}${notes_text.length > 100 ? "..." : ""}` }] };
  }));

  server.tool("add_text_to_slide", "Add a text box to a slide with optional position and size. All measurements are in EMU (1 inch = 914400 EMU).", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    text: z.string(),
    x: z.number().optional().default(457200),
    y: z.number().optional().default(457200),
    width: z.number().optional().default(8229600),
    height: z.number().optional().default(1143000),
    object_id: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, text, x = 457200, y = 457200, width = 8229600, height = 1143000, object_id }) => {
    const { accessToken } = await getCreds();
    const shapeId = object_id || `textbox_${Date.now()}`;
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [
        { createShape: { objectId: shapeId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: slide_object_id, size: { height: { magnitude: height, unit: "EMU" }, width: { magnitude: width, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "EMU" } } } },
        { insertText: { objectId: shapeId, insertionIndex: 0, text } },
      ],
    });
    return { content: [{ type: "text", text: `Text box added!\nShape ID: ${shapeId}\nText: ${text.substring(0, 80)}${text.length > 80 ? "..." : ""}` }] };
  }));

  server.tool("delete_page_element", "Delete a shape, image, table, or any page element from a slide.", {
    presentation_id: z.string(),
    object_id: z.string().describe("Object ID of the element to delete"),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ presentation_id, object_id }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [{ deleteObject: { objectId: object_id } }] });
    return { content: [{ type: "text", text: `Element deleted!\nObject ID: ${object_id}` }] };
  }));

  server.tool("update_shape_position", "Move and/or resize a shape/element on a slide. Measurements in EMU (1 inch = 914400 EMU).", {
    presentation_id: z.string(),
    object_id: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, object_id, x, y, width, height }) => {
    const { accessToken } = await getCreds();
    const requests: any[] = [];
    if (x !== undefined || y !== undefined) {
      const transform: any = { scaleX: 1, scaleY: 1, unit: "EMU" };
      if (x !== undefined) transform.translateX = x;
      if (y !== undefined) transform.translateY = y;
      requests.push({ updatePageElementTransform: { objectId: object_id, transform, applyMode: "RELATIVE" } });
    }
    if (width !== undefined || height !== undefined) {
      const size: any = {};
      if (width !== undefined) size.width = { magnitude: width, unit: "EMU" };
      if (height !== undefined) size.height = { magnitude: height, unit: "EMU" };
      requests.push({ updatePageElementSize: { objectId: object_id, size } });
    }
    if (requests.length === 0) return { content: [{ type: "text", text: "No changes specified. Provide x, y, width or height." }] };
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests });
    return { content: [{ type: "text", text: `Shape updated!\nObject ID: ${object_id}\nChanges: ${JSON.stringify({ x, y, width, height })}` }] };
  }));

  server.tool("replace_all_text", "Find and replace all occurrences of text across the entire presentation or specific slides.", {
    presentation_id: z.string(),
    find_text: z.string(),
    replace_text: z.string(),
    match_case: z.boolean().optional().default(false),
    page_object_ids: z.array(z.string()).optional().describe("Limit to specific slide IDs (omit for all slides)"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, find_text, replace_text, match_case = false, page_object_ids }) => {
    const { accessToken } = await getCreds();
    const req: any = { replaceAllText: { containsText: { text: find_text, matchCase: match_case }, replaceText: replace_text } };
    if (page_object_ids?.length) req.replaceAllText.pageObjectIds = page_object_ids;
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [req] }) as any;
    const count = result.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
    return { content: [{ type: "text", text: `Text replaced!\n"${find_text}" → "${replace_text}"\nOccurrences changed: ${count}` }] };
  }));

  server.tool("update_text_style", "Apply text formatting (bold, italic, underline, font size, color, font family) to a range of text in a shape.", {
    presentation_id: z.string(),
    object_id: z.string(),
    start_index: z.number(),
    end_index: z.number(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    font_size_pt: z.number().optional(),
    font_family: z.string().optional(),
    red: z.number().min(0).max(1).optional(),
    green: z.number().min(0).max(1).optional(),
    blue: z.number().min(0).max(1).optional(),
  }, withErrorHandler(async ({ presentation_id, object_id, start_index, end_index, bold, italic, underline, strikethrough, font_size_pt, font_family, red, green, blue }) => {
    const { accessToken } = await getCreds();
    const textStyle: any = {};
    const fields: string[] = [];
    if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
    if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
    if (underline !== undefined) { textStyle.underline = underline; fields.push("underline"); }
    if (strikethrough !== undefined) { textStyle.strikethrough = strikethrough; fields.push("strikethrough"); }
    if (font_size_pt !== undefined) { textStyle.fontSize = { magnitude: font_size_pt, unit: "PT" }; fields.push("fontSize"); }
    if (font_family !== undefined) { textStyle.fontFamily = font_family; fields.push("fontFamily"); }
    if (red !== undefined || green !== undefined || blue !== undefined) {
      textStyle.foregroundColor = { opaqueColor: { rgbColor: { red: red ?? 0, green: green ?? 0, blue: blue ?? 0 } } };
      fields.push("foregroundColor");
    }
    if (fields.length === 0) return { content: [{ type: "text", text: "No style changes specified." }] };
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ updateTextStyle: { objectId: object_id, textRange: { type: "FIXED_RANGE", startIndex: start_index, endIndex: end_index }, style: textStyle, fields: fields.join(",") } }],
    });
    return { content: [{ type: "text", text: `Text style updated!\nObject: ${object_id}\nRange: [${start_index}, ${end_index})\nFields: ${fields.join(", ")}` }] };
  }));

  server.tool("update_paragraph_alignment", "Set text alignment for paragraphs within a shape.", {
    presentation_id: z.string(),
    object_id: z.string(),
    start_index: z.number(),
    end_index: z.number(),
    alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]),
  }, withErrorHandler(async ({ presentation_id, object_id, start_index, end_index, alignment }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ updateParagraphStyle: { objectId: object_id, textRange: { type: "FIXED_RANGE", startIndex: start_index, endIndex: end_index }, style: { alignment }, fields: "alignment" } }],
    });
    return { content: [{ type: "text", text: `Paragraph alignment set to ${alignment}!\nObject: ${object_id}` }] };
  }));

  server.tool("insert_image", "Insert an image from a URL into a slide. Measurements in EMU (1 inch = 914400 EMU).", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    image_url: z.string(),
    x: z.number().optional().default(457200),
    y: z.number().optional().default(457200),
    width: z.number().optional().default(3200000),
    height: z.number().optional().default(2400000),
    object_id: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, image_url, x = 457200, y = 457200, width = 3200000, height = 2400000, object_id }) => {
    const { accessToken } = await getCreds();
    const imageId = object_id || `image_${Date.now()}`;
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ createImage: { objectId: imageId, url: image_url, elementProperties: { pageObjectId: slide_object_id, size: { height: { magnitude: height, unit: "EMU" }, width: { magnitude: width, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "EMU" } } } }],
    }) as any;
    const newId = result.replies?.[0]?.createImage?.objectId || imageId;
    return { content: [{ type: "text", text: `Image inserted.\nImage ID: ${newId}\nURL: ${image_url}` }] };
  }));

  server.tool("replace_all_shapes_with_image", "Replace all shapes matching a tag text with an image URL across the presentation.", {
    presentation_id: z.string(),
    contains_text: z.string().describe("Text to match in shape (e.g. '{{hero_image}}')"),
    image_url: z.string(),
    image_replace_method: z.enum(["CENTER_INSIDE", "CENTER_CROP"]).optional().default("CENTER_INSIDE"),
  }, withErrorHandler(async ({ presentation_id, contains_text, image_url, image_replace_method = "CENTER_INSIDE" }) => {
    const { accessToken } = await getCreds();
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ replaceAllShapesWithImage: { imageUrl: image_url, imageReplaceMethod: image_replace_method, containsText: { text: contains_text, matchCase: false } } }],
    }) as any;
    const count = result.replies?.[0]?.replaceAllShapesWithImage?.occurrencesChanged || 0;
    return { content: [{ type: "text", text: `Shapes replaced with image!\nMatched text: "${contains_text}"\nOccurrences changed: ${count}` }] };
  }));

  server.tool("create_table", "Create a new table on a slide. Measurements in EMU (1 inch = 914400 EMU).", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    rows: z.number().int().min(1),
    columns: z.number().int().min(1),
    x: z.number().optional().default(457200),
    y: z.number().optional().default(457200),
    width: z.number().optional().default(8229600),
    height: z.number().optional().default(2743200),
    object_id: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, rows, columns, x = 457200, y = 457200, width = 8229600, height = 2743200, object_id }) => {
    const { accessToken } = await getCreds();
    const tableId = object_id || `table_${Date.now()}`;
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ createTable: { objectId: tableId, elementProperties: { pageObjectId: slide_object_id, size: { height: { magnitude: height, unit: "EMU" }, width: { magnitude: width, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "EMU" } }, rows, columns } }],
    }) as any;
    const newId = result.replies?.[0]?.createTable?.objectId || tableId;
    return { content: [{ type: "text", text: `Table created.\nTable ID: ${newId}\nSize: ${rows} rows × ${columns} columns` }] };
  }));

  server.tool("update_table_cell_text", "Set text content in a specific table cell (replaces existing text).", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0),
    column_index: z.number().int().min(0),
    text: z.string(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, table_object_id, row_index, column_index, text }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [
        { deleteText: { objectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index }, textRange: { type: "ALL" } } },
        { insertText: { objectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index }, insertionIndex: 0, text } },
      ],
    });
    return { content: [{ type: "text", text: `Table cell updated!\nTable: ${table_object_id}\nCell: [${row_index}, ${column_index}]\nText: ${text.substring(0, 60)}` }] };
  }));

  server.tool("insert_table_rows", "Insert one or more rows into a table on a slide.", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0),
    column_index: z.number().int().min(0).optional().default(0),
    insert_below: z.boolean().optional().default(true),
    number: z.number().int().min(1).optional().default(1),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, table_object_id, row_index, column_index = 0, insert_below = true, number = 1 }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ insertTableRows: { tableObjectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index }, insertBelow: insert_below, number } }],
    });
    return { content: [{ type: "text", text: `${number} row(s) inserted!\nTable: ${table_object_id}\nPosition: ${insert_below ? "below" : "above"} row ${row_index}` }] };
  }));

  server.tool("delete_table_row", "Delete a row from a table on a slide.", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0),
    column_index: z.number().int().min(0).optional().default(0),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ presentation_id, table_object_id, row_index, column_index = 0 }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ deleteTableRow: { tableObjectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index } } }],
    });
    return { content: [{ type: "text", text: `Row ${row_index} deleted!\nTable: ${table_object_id}` }] };
  }));

  server.tool("insert_table_columns", "Insert one or more columns into a table on a slide.", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0).optional().default(0),
    column_index: z.number().int().min(0),
    insert_right: z.boolean().optional().default(true),
    number: z.number().int().min(1).optional().default(1),
  }, withErrorHandler(async ({ presentation_id, table_object_id, row_index = 0, column_index, insert_right = true, number = 1 }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ insertTableColumns: { tableObjectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index }, insertRight: insert_right, number } }],
    });
    return { content: [{ type: "text", text: `${number} column(s) inserted!\nTable: ${table_object_id}\nPosition: ${insert_right ? "right of" : "left of"} column ${column_index}` }] };
  }));

  server.tool("delete_table_column", "Delete a column from a table on a slide.", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0).optional().default(0),
    column_index: z.number().int().min(0),
  }, withErrorHandler(async ({ presentation_id, table_object_id, row_index = 0, column_index }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ deleteTableColumn: { tableObjectId: table_object_id, cellLocation: { rowIndex: row_index, columnIndex: column_index } } }],
    });
    return { content: [{ type: "text", text: `Column ${column_index} deleted!\nTable: ${table_object_id}` }] };
  }));

  server.tool("update_table_cell_style", "Apply background color and border to a table cell.", {
    presentation_id: z.string(),
    table_object_id: z.string(),
    row_index: z.number().int().min(0),
    column_index: z.number().int().min(0),
    bg_red: z.number().min(0).max(1).optional(),
    bg_green: z.number().min(0).max(1).optional(),
    bg_blue: z.number().min(0).max(1).optional(),
    border_color_red: z.number().min(0).max(1).optional(),
    border_color_green: z.number().min(0).max(1).optional(),
    border_color_blue: z.number().min(0).max(1).optional(),
    border_weight_pt: z.number().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, table_object_id, row_index, column_index, bg_red, bg_green, bg_blue, border_color_red, border_color_green, border_color_blue, border_weight_pt }) => {
    const { accessToken } = await getCreds();
    const tableCellStyle: any = {};
    const fields: string[] = [];
    if (bg_red !== undefined || bg_green !== undefined || bg_blue !== undefined) {
      tableCellStyle.tableCellBackgroundFill = { solidFill: { color: { rgbColor: { red: bg_red ?? 1, green: bg_green ?? 1, blue: bg_blue ?? 1 } } } };
      fields.push("tableCellBackgroundFill");
    }
    if (border_color_red !== undefined || border_weight_pt !== undefined) {
      const border: any = { tableBorderProperties: {} };
      if (border_color_red !== undefined) {
        border.tableBorderProperties.tableBorderFill = { solidFill: { color: { rgbColor: { red: border_color_red ?? 0, green: border_color_green ?? 0, blue: border_color_blue ?? 0 } } } };
      }
      if (border_weight_pt !== undefined) border.tableBorderProperties.weight = { magnitude: border_weight_pt, unit: "PT" };
      tableCellStyle.borderBottom = border;
      tableCellStyle.borderTop = border;
      tableCellStyle.borderLeft = border;
      tableCellStyle.borderRight = border;
      fields.push("borderBottom", "borderTop", "borderLeft", "borderRight");
    }
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ updateTableCellProperties: { objectId: table_object_id, tableRange: { location: { rowIndex: row_index, columnIndex: column_index }, rowSpan: 1, columnSpan: 1 }, tableCellProperties: tableCellStyle, fields: fields.join(",") } }],
    });
    return { content: [{ type: "text", text: `Table cell styled!\nTable: ${table_object_id}\nCell: [${row_index}, ${column_index}]` }] };
  }));
}
