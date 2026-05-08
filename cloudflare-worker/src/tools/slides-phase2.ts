/**
 * Google Slides — Phase 2D Tools
 * Adds: create_shape, create_line, group_objects, update_shape_properties
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

const SLIDES_BASE = "https://slides.googleapis.com/v1/presentations";

async function slidesBatch(accessToken: string, presentationId: string, requests: unknown[]) {
  return googleFetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, accessToken, "POST", { requests });
}

function hexToRgb(hex: string) {
  const h = hex.replace("#","");
  return { red: parseInt(h.slice(0,2),16)/255, green: parseInt(h.slice(2,4),16)/255, blue: parseInt(h.slice(4,6),16)/255 };
}

// 1 inch = 914400 EMU, 1 pt = 12700 EMU
function ptToEmu(pt: number) { return Math.round(pt * 12700); }

function solidFill(hex: string) {
  return { solidFill: { color: { rgbColor: hexToRgb(hex) } } };
}

export function registerSlidesPhase2Tools(server: McpServer, getCreds: GetCredsFunc) {

  // ── create_shape ─────────────────────────────────────────────────────────

  server.tool("create_shape",
    "Create a shape on a Google Slides slide. Supports rectangles, ellipses, arrows, stars, callouts, and many more. " +
    "All dimensions in points (pt). 1 inch = 72pt.",
    {
      presentation_id:  z.string(),
      slide_object_id:  z.string().describe("The objectId of the target slide"),
      shape_type:       z.enum([
        "RECTANGLE","ELLIPSE","ROUND_RECTANGLE","TRIANGLE",
        "ARROW_EAST","ARROW_NORTH","ARROW_SOUTH","ARROW_WEST",
        "ARROW_LEFT_RIGHT","ARROW_UP_DOWN",
        "STAR_5","STAR_6","STAR_8",
        "CALLOUT_RECTANGLE","CALLOUT_ROUND_RECTANGLE",
        "CLOUD","HEART","LIGHTNING_BOLT","CROSS","PENTAGON","HEXAGON","OCTAGON",
        "CHEVRON","FLOW_CHART_PROCESS","FLOW_CHART_DECISION","FLOW_CHART_TERMINATOR",
      ]),
      x:             z.number().describe("Left position in points"),
      y:             z.number().describe("Top position in points"),
      width:         z.number().describe("Width in points"),
      height:        z.number().describe("Height in points"),
      fill_color:    z.string().optional().describe("Fill hex color, e.g. '#4F46E5'"),
      outline_color: z.string().optional().describe("Outline/border hex color"),
      outline_weight_pt: z.number().optional().default(1).describe("Border weight in points"),
      text:          z.string().optional().describe("Text to place inside the shape"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ presentation_id, slide_object_id, shape_type, x, y, width, height, fill_color, outline_color, outline_weight_pt = 1, text }) => {
      const { accessToken } = await getCreds();
      const objectId = `shape_${Date.now()}`;

      const requests: any[] = [
        {
          createShape: {
            objectId,
            shapeType: shape_type,
            elementProperties: {
              pageObjectId: slide_object_id,
              size: {
                width:  { magnitude: ptToEmu(width),  unit: "EMU" },
                height: { magnitude: ptToEmu(height), unit: "EMU" },
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: ptToEmu(x),
                translateY: ptToEmu(y),
                unit: "EMU",
              },
            },
          },
        },
      ];

      // Apply fill/outline properties
      const shapeProps: any = {};
      let shapeFields = "";

      if (fill_color) {
        shapeProps.shapeBackgroundFill = solidFill(fill_color);
        shapeFields += "shapeBackgroundFill.solidFill.color,";
      }
      if (outline_color) {
        shapeProps.outline = {
          outlineFill: solidFill(outline_color),
          weight: { magnitude: ptToEmu(outline_weight_pt), unit: "EMU" },
        };
        shapeFields += "outline.outlineFill.solidFill.color,outline.weight,";
      }

      if (shapeFields) {
        requests.push({
          updateShapeProperties: {
            objectId,
            shapeProperties: shapeProps,
            fields: shapeFields.slice(0, -1),
          },
        });
      }

      if (text) {
        requests.push({
          insertText: { objectId, text, insertionIndex: 0 },
        });
      }

      await slidesBatch(accessToken, presentation_id, requests);
      return { content: [{ type: "text", text: `Shape "${shape_type}" created. ObjectId: ${objectId}` }] };
    }),
  );

  // ── create_line ─────────────────────────────────────────────────────────────

  server.tool("create_line",
    "Create a line or connector on a Google Slides slide. Supports straight, bent, and curved lines with optional arrowheads.",
    {
      presentation_id: z.string(),
      slide_object_id: z.string(),
      line_type:       z.enum(["STRAIGHT","BENT","CURVED"]).default("STRAIGHT"),
      start_x:  z.number().describe("Start X position in points"),
      start_y:  z.number().describe("Start Y position in points"),
      end_x:    z.number().describe("End X position in points"),
      end_y:    z.number().describe("End Y position in points"),
      color:    z.string().optional().describe("Line hex color"),
      weight_pt: z.number().optional().default(2).describe("Line thickness in points"),
      dash_style: z.enum(["SOLID","DOT","DASH","DASH_DOT","LONG_DASH","LONG_DASH_DOT"]).optional().default("SOLID"),
      start_arrow: z.enum(["NONE","ARROW","OPEN","STEALTH","DIAMOND","CIRCLE"]).optional().default("NONE"),
      end_arrow:   z.enum(["NONE","ARROW","OPEN","STEALTH","DIAMOND","CIRCLE"]).optional().default("NONE"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ presentation_id, slide_object_id, line_type, start_x, start_y, end_x, end_y, color, weight_pt = 2, dash_style = "SOLID", start_arrow = "NONE", end_arrow = "NONE" }) => {
      const { accessToken } = await getCreds();
      const objectId = `line_${Date.now()}`;
      // Calculate bounding box from start/end points
      const minX = Math.min(start_x, end_x);
      const minY = Math.min(start_y, end_y);
      const w = Math.abs(end_x - start_x) || 1;
      const h = Math.abs(end_y - start_y) || 1;

      const lineTypeMap: Record<string, string> = {
        STRAIGHT: "STRAIGHT_CONNECTOR_1",
        BENT:     "BENT_CONNECTOR_3",
        CURVED:   "CURVED_CONNECTOR_3",
      };

      const requests: any[] = [
        {
          createLine: {
            objectId,
            lineType: lineTypeMap[line_type] || "STRAIGHT_CONNECTOR_1",
            elementProperties: {
              pageObjectId: slide_object_id,
              size: {
                width:  { magnitude: ptToEmu(w), unit: "EMU" },
                height: { magnitude: ptToEmu(h), unit: "EMU" },
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: ptToEmu(minX),
                translateY: ptToEmu(minY),
                unit: "EMU",
              },
            },
          },
        },
      ];

      // Apply line properties
      const lineProps: any = {
        dashStyle: dash_style,
        weight: { magnitude: ptToEmu(weight_pt), unit: "EMU" },
        startArrow: start_arrow + (start_arrow !== "NONE" ? "_HEAD" : ""),
        endArrow:   end_arrow   + (end_arrow   !== "NONE" ? "_HEAD" : ""),
      };
      let fields = "dashStyle,weight";
      if (start_arrow !== "NONE") fields += ",startArrow";
      if (end_arrow   !== "NONE") fields += ",endArrow";
      if (color) {
        lineProps.lineFill = solidFill(color);
        fields += ",lineFill.solidFill.color";
      }

      requests.push({
        updateLineProperties: { objectId, lineProperties: lineProps, fields },
      });

      await slidesBatch(accessToken, presentation_id, requests);
      return { content: [{ type: "text", text: `Line created. ObjectId: ${objectId}` }] };
    }),
  );

  // ── group_objects ───────────────────────────────────────────────────────────

  server.tool("group_objects",
    "Group or ungroup objects on a Google Slides slide.",
    {
      action:           z.enum(["group","ungroup"]),
      presentation_id:  z.string(),
      child_object_ids: z.array(z.string()).optional().describe("Object IDs to group (required for group action)"),
      group_object_id:  z.string().optional().describe("Group object ID to ungroup (required for ungroup action)"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, presentation_id, child_object_ids, group_object_id }) => {
      const { accessToken } = await getCreds();
      if (action === "group") {
        if (!child_object_ids?.length) throw new Error("child_object_ids required for group");
        const objectId = `group_${Date.now()}`;
        await slidesBatch(accessToken, presentation_id, [{
          groupObjects: { groupObjectId: objectId, childrenObjectIds: child_object_ids },
        }]);
        return { content: [{ type: "text", text: `${child_object_ids.length} objects grouped. Group ObjectId: ${objectId}` }] };
      } else {
        if (!group_object_id) throw new Error("group_object_id required for ungroup");
        await slidesBatch(accessToken, presentation_id, [{
          ungroupObjects: { objectIds: [group_object_id] },
        }]);
        return { content: [{ type: "text", text: `Group ${group_object_id} ungrouped.` }] };
      }
    }),
  );

  // ── update_shape_properties ─────────────────────────────────────────────────

  server.tool("update_shape_properties",
    "Update fill color, outline, or shadow of an existing shape on a Google Slides slide.",
    {
      presentation_id:   z.string(),
      object_id:         z.string(),
      fill_color_hex:    z.string().optional().describe("New fill hex color"),
      outline_color_hex: z.string().optional().describe("New outline hex color"),
      outline_weight_pt: z.number().optional().describe("Outline thickness in points"),
      shadow:            z.boolean().optional().describe("Enable/disable drop shadow"),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ presentation_id, object_id, fill_color_hex, outline_color_hex, outline_weight_pt, shadow }) => {
      const { accessToken } = await getCreds();
      const shapeProps: any = {};
      const fields: string[] = [];

      if (fill_color_hex) {
        shapeProps.shapeBackgroundFill = solidFill(fill_color_hex);
        fields.push("shapeBackgroundFill.solidFill.color");
      }
      if (outline_color_hex || outline_weight_pt !== undefined) {
        shapeProps.outline = {};
        if (outline_color_hex) {
          shapeProps.outline.outlineFill = solidFill(outline_color_hex);
          fields.push("outline.outlineFill.solidFill.color");
        }
        if (outline_weight_pt !== undefined) {
          shapeProps.outline.weight = { magnitude: ptToEmu(outline_weight_pt), unit: "EMU" };
          fields.push("outline.weight");
        }
      }
      if (shadow !== undefined) {
        shapeProps.shadow = { type: shadow ? "OUTER" : "NO_SHADOW", enabled: shadow };
        fields.push("shadow.type","shadow.enabled");
      }

      if (!fields.length) return { content: [{ type: "text", text: "No changes specified." }] };

      await slidesBatch(accessToken, presentation_id, [{
        updateShapeProperties: { objectId: object_id, shapeProperties: shapeProps, fields: fields.join(",") },
      }]);
      return { content: [{ type: "text", text: `Shape ${object_id} properties updated.` }] };
    }),
  );

} // end registerSlidesPhase2Tools
