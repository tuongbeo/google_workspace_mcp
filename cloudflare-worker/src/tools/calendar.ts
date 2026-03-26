/**
 * Google Calendar MCP Tools — Full implementation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calendarRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerCalendarTools(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("list_calendars", "List all Google calendars accessible to the user.", {}, { readOnlyHint: true }, withErrorHandler(async () => {
    const { accessToken } = await getCreds();
    const data = await calendarRequest(accessToken, "/users/me/calendarList") as any;
    const items = data.items || [];
    const lines = items.map((c: any) => `- ${c.summary}${c.primary ? " (Primary)" : ""} | ID: ${c.id} | Color: ${c.backgroundColor || "N/A"}`);
    return { content: [{ type: "text", text: `Calendars (${items.length}):\n${lines.join("\n")}` }] };
  }));

  server.tool("get_calendar_events", "Get events from a Google Calendar.", {
    calendar_id: z.string().optional().default("primary"),
    time_min: z.string().optional().describe("Start time RFC3339 (default: now)"),
    time_max: z.string().optional(),
    max_results: z.number().optional().default(25),
    query: z.string().optional().describe("Free text search"),
    show_deleted: z.boolean().optional().default(false),
  }, { readOnlyHint: true }, withErrorHandler(async ({ calendar_id = "primary", time_min, time_max, max_results = 25, query, show_deleted = false }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: String(max_results) });
    params.set("timeMin", time_min || new Date().toISOString());
    if (time_max) params.set("timeMax", time_max);
    if (query) params.set("q", query);
    if (show_deleted) params.set("showDeleted", "true");
    const data = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events?${params}`) as any;
    const events = data.items || [];
    if (!events.length) return { content: [{ type: "text", text: "No events found." }] };
    const lines = [`${events.length} events:`, ""];
    for (const ev of events) {
      const start = ev.start?.dateTime || ev.start?.date || "?";
      const end = ev.end?.dateTime || ev.end?.date || "?";
      lines.push(`📅 ${ev.summary || "(no title)"}`);
      lines.push(`   Start: ${start} | End: ${end}`);
      if (ev.location) lines.push(`   Location: ${ev.location}`);
      const meetUrl = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri;
      if (meetUrl) lines.push(`   Meeting: ${meetUrl}`);
      if (ev.attendees?.length) lines.push(`   Attendees: ${ev.attendees.map((a: any) => `${a.email} (${a.responseStatus})`).join(", ")}`);
      lines.push(`   ID: ${ev.id} | Status: ${ev.status} | Link: ${ev.htmlLink || "N/A"}`);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("get_calendar_event", "Get full details of a specific calendar event.", {
    event_id: z.string(),
    calendar_id: z.string().optional().default("primary"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ event_id, calendar_id = "primary" }) => {
    const { accessToken } = await getCreds();
    const ev = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`) as any;
    const lines = [
      `Event: ${ev.summary || "(no title)"}`, `ID: ${ev.id}`,
      `Status: ${ev.status}`, `Start: ${ev.start?.dateTime || ev.start?.date}`,
      `End: ${ev.end?.dateTime || ev.end?.date}`,
      `Organizer: ${ev.organizer?.email || "N/A"}`,
      `Description: ${ev.description || "N/A"}`, `Location: ${ev.location || "N/A"}`,
      `Link: ${ev.htmlLink || "N/A"}`,
    ];
    if (ev.attendees?.length) lines.push(`Attendees:\n${ev.attendees.map((a: any) => `  - ${a.email}: ${a.responseStatus}`).join("\n")}`);
    if (ev.conferenceData?.entryPoints) {
      const meet = ev.conferenceData.entryPoints.find((e: any) => e.entryPointType === "video");
      if (meet) lines.push(`Google Meet: ${meet.uri}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("create_calendar_event", "Create a new Google Calendar event.", {
    summary: z.string(),
    start_time: z.string().describe("RFC3339, e.g. 2025-03-15T10:00:00+07:00"),
    end_time: z.string(),
    calendar_id: z.string().optional().default("primary"),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    add_google_meet: z.boolean().optional().default(false),
    timezone: z.string().optional(),
    recurrence: z.array(z.string()).optional().describe("RRULE strings, e.g. ['RRULE:FREQ=WEEKLY;BYDAY=MO']"),
    color_id: z.string().optional().describe("1-11: 1=Lavender,2=Sage,3=Grape,4=Flamingo,5=Banana,6=Tangerine,7=Peacock,8=Graphite,9=Blueberry,10=Basil,11=Tomato"),
    all_day: z.boolean().optional().default(false),
    visibility: z.enum(["default", "public", "private", "confidential"]).optional().describe("Event visibility for attendees"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ summary, start_time, end_time, calendar_id = "primary", description, location, attendees, add_google_meet, timezone, recurrence, color_id, all_day = false, visibility }) => {
    const { accessToken } = await getCreds();
    const event: Record<string, unknown> = { summary };
    if (all_day) {
      event.start = { date: start_time.split("T")[0] };
      event.end = { date: end_time.split("T")[0] };
    } else {
      event.start = { dateTime: start_time, timeZone: timezone };
      event.end = { dateTime: end_time, timeZone: timezone };
    }
    if (description) event.description = description;
    if (location) event.location = location;
    if (attendees?.length) event.attendees = attendees.map(e => ({ email: e }));
    if (recurrence?.length) event.recurrence = recurrence;
    if (color_id) event.colorId = color_id;
    if (visibility) event.visibility = visibility;
    if (add_google_meet) {
      event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }
    const params = add_google_meet ? "?conferenceDataVersion=1" : "";
    const result = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events${params}`, "POST", event) as any;
    let msg = `Event created: "${result.summary}"\nID: ${result.id}\nLink: ${result.htmlLink}`;
    if (add_google_meet && result.conferenceData?.entryPoints) {
      const meet = result.conferenceData.entryPoints.find((e: any) => e.entryPointType === "video");
      if (meet) msg += `\nGoogle Meet: ${meet.uri}`;
    }
    return { content: [{ type: "text", text: msg }] };
  }));

  server.tool("update_calendar_event", "Update an existing Google Calendar event.", {
    event_id: z.string(),
    calendar_id: z.string().optional().default("primary"),
    summary: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(z.string()).optional().describe("Full attendee list (replaces existing)"),
    color_id: z.string().optional(),
    send_updates: z.enum(["all", "externalOnly", "none"]).optional().default("all"),
    visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ event_id, calendar_id = "primary", summary, start_time, end_time, description, location, attendees, color_id, send_updates = "all", visibility }) => {
    const { accessToken } = await getCreds();
    const patch: Record<string, unknown> = {};
    if (summary) patch.summary = summary;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;
    if (start_time) patch.start = { dateTime: start_time };
    if (end_time) patch.end = { dateTime: end_time };
    if (attendees?.length) patch.attendees = attendees.map(e => ({ email: e }));
    if (color_id) patch.colorId = color_id;
    if (visibility) patch.visibility = visibility;
    const result = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}?sendUpdates=${send_updates}`, "PATCH", patch) as any;
    return { content: [{ type: "text", text: `Event updated: "${result.summary}"\nLink: ${result.htmlLink}` }] };
  }));

  server.tool("delete_calendar_event", "Delete a Google Calendar event.", {
    event_id: z.string(),
    calendar_id: z.string().optional().default("primary"),
    send_updates: z.enum(["all", "externalOnly", "none"]).optional().default("all"),
  }, withErrorHandler(async ({ event_id, calendar_id = "primary", send_updates = "all" }) => {
    const { accessToken } = await getCreds();
    await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}?sendUpdates=${send_updates}`, "DELETE");
    return { content: [{ type: "text", text: `Event ${event_id} deleted.` }] };
  }));

  server.tool("respond_to_calendar_event", "RSVP to a calendar event invitation.", {
    event_id: z.string(),
    response: z.enum(["accepted", "declined", "tentative"]),
    calendar_id: z.string().optional().default("primary"),
    comment: z.string().optional(),
  }, withErrorHandler(async ({ event_id, response, calendar_id = "primary", comment }) => {
    const { accessToken } = await getCreds();
    const ev = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`) as any;
    const attendees = (ev.attendees || []).map((a: any) =>
      a.self ? { ...a, responseStatus: response, comment: comment || a.comment } : a
    );
    const result = await calendarRequest(accessToken, `/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`, "PATCH", { attendees }) as any;
    return { content: [{ type: "text", text: `RSVP updated to "${response}" for event: "${result.summary}"` }] };
  }));

  server.tool("query_calendar_freebusy", "Query free/busy time for calendars.", {
    time_min: z.string().describe("Start time RFC3339"),
    time_max: z.string().describe("End time RFC3339"),
    calendar_ids: z.array(z.string()).optional().default(["primary"]),
  }, { readOnlyHint: true }, withErrorHandler(async ({ time_min, time_max, calendar_ids = ["primary"] }) => {
    const { accessToken } = await getCreds();
    const result = await calendarRequest(accessToken, "/freeBusy", "POST", {
      timeMin: time_min, timeMax: time_max, items: calendar_ids.map(id => ({ id })),
    }) as any;
    const lines = ["Free/Busy Result:", ""];
    for (const [calId, info] of Object.entries(result.calendars || {})) {
      const busy = (info as any).busy || [];
      lines.push(`Calendar: ${calId}`);
      if (!busy.length) lines.push("  → Free for entire range");
      else for (const slot of busy) lines.push(`  Busy: ${slot.start} → ${slot.end}`);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));
}
