/**
 * Apps Script — Phase 2E: manage_triggers
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;
const SCRIPT_BASE = "https://script.googleapis.com/v1";

export function registerAppsScriptPhase2Tools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("manage_triggers",
    "List, create, or delete Apps Script time-based and event-driven triggers.",
    {
      action:        z.enum(["list","create","delete"]),
      script_id:     z.string(),
      trigger_id:    z.string().optional().describe("Trigger ID (required for delete)"),
      function_name: z.string().optional().describe("Function to call (required for create)"),
      trigger_type:  z.enum(["CLOCK","CALENDAR_EVENT_UPDATED","FORM_SUBMIT","SPREADSHEET_OPEN","SPREADSHEET_EDIT","SPREADSHEET_CHANGE","SPREADSHEET_ON_FORM_SUBMIT","DOCUMENT_OPEN"]).optional(),
      schedule: z.object({
        every_minutes: z.number().int().optional().describe("Run every N minutes (1, 5, 10, 15, 30)"),
        every_hours:   z.number().int().optional().describe("Run every N hours (1, 2, 4, 6, 8, 12)"),
        at_hour:       z.number().int().min(0).max(23).optional().describe("Hour of day (0-23) for daily trigger"),
        day_of_week:   z.number().int().min(1).max(7).optional().describe("Day of week (1=Mon, 7=Sun) for weekly trigger"),
      }).optional(),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ action, script_id, trigger_id, function_name, trigger_type, schedule }) => {
      const { accessToken } = await getCreds();

      if (action === "list") {
        const data = await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/triggers`, accessToken) as any;
        const triggers = data.triggers || [];
        if (!triggers.length) return { content: [{ type: "text", text: "No triggers found." }] };
        const lines = triggers.map((t: any) =>
          `ID: ${t.triggerId} | Fn: ${t.functionName} | Type: ${t.eventType} | Source: ${t.triggerSource}`
        );
        return { content: [{ type: "text", text: `Triggers (${triggers.length}):\n${lines.join("\n")}` }] };
      }

      if (action === "delete") {
        if (!trigger_id) throw new Error("trigger_id required for delete");
        await googleFetch(`${SCRIPT_BASE}/projects/${script_id}/triggers/${trigger_id}`, accessToken, "DELETE");
        return { content: [{ type: "text", text: `Trigger ${trigger_id} deleted.` }] };
      }

      if (action === "create") {
        if (!function_name) throw new Error("function_name required for create");
        const triggerBody: any = {
          functionName: function_name,
          scriptId: script_id,
        };

        if (trigger_type === "CLOCK" || schedule) {
          // Time-based trigger
          if (schedule?.every_minutes) {
            triggerBody.time = { everyMinutes: schedule.every_minutes };
          } else if (schedule?.every_hours) {
            triggerBody.time = { everyHours: schedule.every_hours };
          } else if (schedule?.at_hour !== undefined && schedule?.day_of_week) {
            triggerBody.time = {
              weekDay: schedule.day_of_week,
              atHour: schedule.at_hour,
            };
          } else if (schedule?.at_hour !== undefined) {
            triggerBody.time = { atHour: schedule.at_hour };
          } else {
            triggerBody.time = { everyHours: 1 }; // default: every 1 hour
          }
        } else {
          // Event-based trigger
          triggerBody.eventType = trigger_type || "SPREADSHEET_EDIT";
        }

        const result = await googleFetch(
          `${SCRIPT_BASE}/projects/${script_id}/triggers`,
          accessToken, "POST", triggerBody,
        ) as any;
        return { content: [{ type: "text", text: [
          `Trigger created.`,
          `ID: ${result.triggerId}`,
          `Function: ${result.functionName}`,
          `Type: ${result.eventType || "TIME_BASED"}`,
        ].join("\n") }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }] };
    }),
  );

} // end registerAppsScriptPhase2Tools
