/**
 * Google Tasks MCP Tools
 * Extracted from workspace.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";
import type { GTaskList, GTaskListsResponse, GTask, GTaskListResponse } from "./google-api-types";

function _registerTasksCore(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("list_task_lists", "List all Google Task lists.", {}, { readOnlyHint: true }, withErrorHandler(async () => {
    const { accessToken } = await getCreds();
    const data = await googleFetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken) as GTaskListsResponse;
    const lists = (data.items || []).map(l => `- ${l.title} (ID: ${l.id})`);
    return { content: [{ type: "text", text: `Task Lists:\n${lists.join("\n")}` }] };
  }));

  server.tool("create_task_list", "Create a new Google Task list.", {
    title: z.string(),
  }, withErrorHandler(async ({ title }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken, "POST", { title }) as GTaskList;
    return { content: [{ type: "text", text: `Task list created: "${result.title}" (ID: ${result.id})` }] };
  }));

  server.tool("delete_task_list", "Delete a Google Task list.", {
    tasklist_id: z.string(),
  }, withErrorHandler(async ({ tasklist_id }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${tasklist_id}`, accessToken, "DELETE");
    return { content: [{ type: "text", text: `Task list ${tasklist_id} deleted.` }] };
  }));

  server.tool("list_tasks", "List tasks in a Google Task list.", {
    tasklist_id: z.string().optional().default("@default"),
    show_completed: z.boolean().optional().default(false),
    show_hidden: z.boolean().optional().default(false),
  }, { readOnlyHint: true }, withErrorHandler(async ({ tasklist_id = "@default", show_completed = false, show_hidden = false }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ showCompleted: String(show_completed), showHidden: String(show_hidden), maxResults: "100" });
    const data = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks?${params}`, accessToken) as GTaskListResponse;
    const tasks = data.items || [];
    if (!tasks.length) return { content: [{ type: "text", text: "No tasks found." }] };
    const lines = tasks.map(t => {
      const status = t.status === "completed" ? "✓" : "○";
      const due = t.due ? ` (due: ${t.due.split("T")[0]})` : "";
      const notes = t.notes ? ` | ${t.notes.substring(0, 50)}` : "";
      return `${status} ${t.title}${due}${notes} | ID: ${t.id}`;
    });
    return { content: [{ type: "text", text: `Tasks (${tasks.length}):\n${lines.join("\n")}` }] };
  }));

  server.tool("get_task", "Get details of a specific task.", {
    task_id: z.string(),
    tasklist_id: z.string().optional().default("@default"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ task_id, tasklist_id = "@default" }) => {
    const { accessToken } = await getCreds();
    const t = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken) as GTask;
    return { content: [{ type: "text", text: [`Task: ${t.title}`, `Status: ${t.status}`, `Due: ${t.due?.split("T")[0] || "N/A"}`, `Notes: ${t.notes || "N/A"}`, `ID: ${t.id}`].join("\n") }] };
  }));

  server.tool("create_task", "Create a new task.", {
    title: z.string(),
    tasklist_id: z.string().optional().default("@default"),
    notes: z.string().optional(),
    due: z.string().optional().describe("RFC3339, e.g. 2025-03-20T00:00:00Z"),
    parent: z.string().optional().describe("Parent task ID for subtask"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title, tasklist_id = "@default", notes, due, parent }) => {
    const { accessToken } = await getCreds();
    const body: Record<string, unknown> = { title };
    if (notes) body.notes = notes;
    if (due) body.due = due;
    const params = parent ? `?parent=${parent}` : "";
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks${params}`, accessToken, "POST", body) as GTask;
    return { content: [{ type: "text", text: `Task created: "${result.title}" (ID: ${result.id})` }] };
  }));

  server.tool("update_task", "Update a task (title, status, due date, notes).", {
    task_id: z.string(),
    tasklist_id: z.string().optional().default("@default"),
    title: z.string().optional(),
    status: z.enum(["needsAction", "completed"]).optional(),
    notes: z.string().optional(),
    due: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ task_id, tasklist_id = "@default", title, status, notes, due }) => {
    const { accessToken } = await getCreds();
    const existing = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken) as GTask;
    const body: Record<string, unknown> = { ...existing };
    if (title) body.title = title;
    if (status) {
      body.status = status;
      if (status === "needsAction") body.completed = null;
    }
    if (notes !== undefined) body.notes = notes;
    if (due) body.due = due;
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken, "PUT", body) as GTask;
    return { content: [{ type: "text", text: `Task updated: "${result.title}" | Status: ${result.status}` }] };
  }));

  server.tool("delete_task", "Delete a task.", {
    task_id: z.string(),
    tasklist_id: z.string().optional().default("@default"),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ task_id, tasklist_id = "@default" }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken, "DELETE");
    return { content: [{ type: "text", text: `Task ${task_id} deleted.` }] };
  }));

  server.tool("move_task", "Move a task (change parent or position within task list).", {
    task_id: z.string(),
    tasklist_id: z.string().optional().default("@default"),
    parent: z.string().optional().describe("New parent task ID"),
    previous: z.string().optional().describe("Move after this task ID"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ task_id, tasklist_id = "@default", parent, previous }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams();
    if (parent) params.set("parent", parent);
    if (previous) params.set("previous", previous);
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}/move?${params}`, accessToken, "POST") as GTask;
    return { content: [{ type: "text", text: `Task moved. Position: ${result.position || "updated"}` }] };
  }));

  server.tool("clear_completed_tasks", "Hide all completed tasks in a task list.", {
    tasklist_id: z.string().optional().default("@default"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ tasklist_id = "@default" }) => {
    const { accessToken } = await getCreds();
    await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/clear`, accessToken, "POST");
    return { content: [{ type: "text", text: `Completed tasks cleared from list ${tasklist_id}.` }] };
  }));
}

function _registerTaskListExtra(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_task_list", "Get details of a specific Google Task list.", {
    tasklist_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ tasklist_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${tasklist_id}`, accessToken) as GTaskList;
    return { content: [{ type: "text", text: `Task List: ${data.title}\nID: ${data.id}\nUpdated: ${data.updated || "N/A"}` }] };
  }));
}
export function registerTasksTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerTasksCore(server, getCreds);
  _registerTaskListExtra(server, getCreds);
}
