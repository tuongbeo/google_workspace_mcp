/**
 * Google Workspace MCP Tools: Slides, Chat, Tasks, Forms
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch, slidesRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

// ── Google Slides ─────────────────────────────────────────────────────────────

export function registerSlidesTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_presentation", "Get details and slide content of a Google Slides presentation.", {
    presentation_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ presentation_id }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as any;
    const lines = [`# ${data.title}`, `ID: ${presentation_id}`, `Slides: ${data.slides?.length || 0}`, ""];
    for (const slide of (data.slides || [])) {
      const idx = slide.slideNumber || "?";
      const texts = (slide.pageElements || []).flatMap((el: any) => el.shape?.text?.textElements || []).map((te: any) => te.textRun?.content || "").join("").trim();
      if (texts) lines.push(`[Slide ${idx}] ${texts.substring(0, 200)}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("create_presentation", "Create a new Google Slides presentation.", {
    title: z.string(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch("https://slides.googleapis.com/v1/presentations", accessToken, "POST", { title }) as any;
    return { content: [{ type: "text", text: `Presentation created: "${result.title}"\nID: ${result.presentationId}\nURL: https://docs.google.com/presentation/d/${result.presentationId}/edit` }] };
  }));

  server.tool("add_slide", "Add a new slide to a Google Slides presentation.", {
    presentation_id: z.string(),
    layout: z.enum(["BLANK", "CAPTION_ONLY", "TITLE", "TITLE_AND_BODY", "TITLE_AND_TWO_COLUMNS", "TITLE_ONLY", "SECTION_HEADER", "ONE_COLUMN_TEXT", "MAIN_POINT", "BIG_NUMBER"]).optional().default("BLANK"),
    title: z.string().optional(),
    body_text: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, layout = "BLANK", title, body_text }) => {
    const { accessToken } = await getCreds();
    const insertReq = { createSlide: { slideLayoutReference: { predefinedLayout: layout } } };
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [insertReq] }) as any;
    const newSlideId = result.replies?.[0]?.createSlide?.objectId;
    if ((title || body_text) && newSlideId) {
      const textReqs: any[] = [];
      if (title) {
        const shapeId = `title_${Date.now()}`;
        textReqs.push({ createShape: { objectId: shapeId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: newSlideId, size: { height: { magnitude: 1800000, unit: "EMU" }, width: { magnitude: 8229600, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 457200, translateY: 457200, unit: "EMU" } } } }, { insertText: { objectId: shapeId, insertionIndex: 0, text: title } });
      }
      if (body_text) {
        const shapeId2 = `body_${Date.now()}`;
        textReqs.push({ createShape: { objectId: shapeId2, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: newSlideId, size: { height: { magnitude: 3200000, unit: "EMU" }, width: { magnitude: 8229600, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 457200, translateY: 2743200, unit: "EMU" } } } }, { insertText: { objectId: shapeId2, insertionIndex: 0, text: body_text } });
      }
      await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: textReqs });
    }
    return { content: [{ type: "text", text: `Slide added. Slide ID: ${newSlideId || "unknown"}` }] };
  }));

  server.tool("batch_update_presentation", "Apply multiple raw batchUpdate requests to a Presentation.", {
    presentation_id: z.string(),
    requests: z.array(z.record(z.any())),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, requests }) => {
    const { accessToken } = await getCreds();
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests }) as any;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations.` }] };
  }));

  server.tool("delete_slide", "Delete a slide from a presentation.", {
    presentation_id: z.string(),
    slide_object_id: z.string().describe("Object ID of the slide to delete"),
  }, { readOnlyHint: false, destructiveHint: true }, withErrorHandler(async ({ presentation_id, slide_object_id }) => {
    const { accessToken } = await getCreds();
    await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ deleteObject: { objectId: slide_object_id } }]
    });
    return { content: [{ type: "text", text: `Slide ${slide_object_id} deleted.` }] };
  }));
}

// ── Google Chat ───────────────────────────────────────────────────────────────

export function registerChatTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("list_chat_spaces", "List Google Chat spaces the user is in.", {
    page_size: z.number().optional().default(20),
  }, { readOnlyHint: true }, withErrorHandler(async ({ page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://chat.googleapis.com/v1/spaces?pageSize=${page_size}`, accessToken) as any;
    const spaces = data.spaces || [];
    if (!spaces.length) return { content: [{ type: "text", text: "No Chat spaces found." }] };
    const lines = spaces.map((s: any) => `- ${s.displayName || s.name} (${s.spaceType || "SPACE"}) | ID: ${s.name}`);
    return { content: [{ type: "text", text: `Chat Spaces (${spaces.length}):\n${lines.join("\n")}` }] };
  }));

  server.tool("get_chat_messages", "Get recent messages from a Google Chat space.", {
    space_name: z.string().describe("Space name in format 'spaces/{spaceId}'"),
    page_size: z.number().optional().default(20),
  }, { readOnlyHint: true }, withErrorHandler(async ({ space_name, page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://chat.googleapis.com/v1/${space_name}/messages?pageSize=${page_size}&orderBy=createTime+desc`, accessToken) as any;
    const messages = (data.messages || []).reverse();
    if (!messages.length) return { content: [{ type: "text", text: "No messages." }] };
    const lines = messages.map((m: any) => {
      const sender = m.sender?.displayName || m.sender?.name || "Unknown";
      const text = m.text || "(media/card)";
      const time = m.createTime ? new Date(m.createTime).toLocaleString() : "";
      return `[${time}] ${sender}: ${text}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("send_chat_message", "Send a message to a Google Chat space.", {
    space_name: z.string().describe("Space name like 'spaces/{spaceId}'"),
    text: z.string(),
  }, withErrorHandler(async ({ space_name, text }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://chat.googleapis.com/v1/${space_name}/messages`, accessToken, "POST", { text }) as any;
    return { content: [{ type: "text", text: `Message sent! Message name: ${result.name}` }] };
  }));

  server.tool("search_chat_messages", "Search messages across Google Chat spaces.", {
    query: z.string().describe("Search query"),
    page_size: z.number().optional().default(20),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, page_size = 20 }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ query, pageSize: String(page_size) });
    const data = await googleFetch(`https://chat.googleapis.com/v1/spaces/messages:search?${params}`, accessToken) as any;
    const messages = data.messages || [];
    if (!messages.length) return { content: [{ type: "text", text: `No messages found for: "${query}"` }] };
    const lines = messages.map((m: any) => `[${m.createTime}] ${m.sender?.displayName}: ${m.text || "(media)"}\nSpace: ${m.name}`);
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }));
}

// ── Google Tasks ──────────────────────────────────────────────────────────────

export function registerTasksTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("list_task_lists", "List all Google Task lists.", {}, { readOnlyHint: true }, withErrorHandler(async () => {
    const { accessToken } = await getCreds();
    const data = await googleFetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken) as any;
    const lists = (data.items || []).map((l: any) => `- ${l.title} (ID: ${l.id})`);
    return { content: [{ type: "text", text: `Task Lists:\n${lists.join("\n")}` }] };
  }));

  server.tool("create_task_list", "Create a new Google Task list.", {
    title: z.string(),
  }, withErrorHandler(async ({ title }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", accessToken, "POST", { title }) as any;
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
    const data = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks?${params}`, accessToken) as any;
    const tasks = data.items || [];
    if (!tasks.length) return { content: [{ type: "text", text: "No tasks found." }] };
    const lines = tasks.map((t: any) => {
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
    const t = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken) as any;
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
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks${params}`, accessToken, "POST", body) as any;
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
    const existing = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken) as any;
    const body: Record<string, unknown> = { ...existing };
    if (title) body.title = title;
    if (status) body.status = status;
    if (notes !== undefined) body.notes = notes;
    if (due) body.due = due;
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}`, accessToken, "PUT", body) as any;
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
    const result = await googleFetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist_id}/tasks/${task_id}/move?${params}`, accessToken, "POST") as any;
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

// ── Google Forms ──────────────────────────────────────────────────────────────

export function registerFormsTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_form", "Get details and structure of a Google Form.", {
    form_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ form_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}`, accessToken) as any;
    const lines = [`Form: ${data.info?.title}`, `ID: ${data.formId}`, `Description: ${data.info?.description || "N/A"}`, `Items: ${data.items?.length || 0}`, `Responder URI: ${data.responderUri || "N/A"}`, "", "Questions:"];
    for (const item of (data.items || [])) {
      const q = item.questionItem?.question;
      if (!q) continue;
      const type = q.textQuestion ? "TEXT" : q.choiceQuestion ? "CHOICE" : q.scaleQuestion ? "SCALE" : q.dateQuestion ? "DATE" : "OTHER";
      lines.push(`  - [${type}${q.required ? "*" : ""}] ${item.title || "Untitled"}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("create_form", "Create a new Google Form.", {
    title: z.string(),
    description: z.string().optional(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title, description }) => {
    const { accessToken } = await getCreds();
    const info: Record<string, string> = { title };
    if (description) info.description = description;
    const result = await googleFetch("https://forms.googleapis.com/v1/forms", accessToken, "POST", { info }) as any;
    return { content: [{ type: "text", text: `Form created: "${result.info?.title}"\nID: ${result.formId}\nEdit: https://docs.google.com/forms/d/${result.formId}/edit\nRespond: ${result.responderUri}` }] };
  }));

  server.tool("batch_update_form", "Apply batch updates to a Google Form (add/modify questions, settings).", {
    form_id: z.string(),
    requests: z.array(z.record(z.any())).describe("Array of Forms API batchUpdate request objects"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ form_id, requests }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}:batchUpdate`, accessToken, "POST", { requests }) as any;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations.` }] };
  }));

  server.tool("list_form_responses", "List responses to a Google Form.", {
    form_id: z.string(),
    page_size: z.number().optional().default(10),
  }, withErrorHandler(async ({ form_id, page_size = 10 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}/responses?pageSize=${page_size}`, accessToken) as any;
    const responses = data.responses || [];
    if (!responses.length) return { content: [{ type: "text", text: "No responses yet." }] };
    const lines = [`${responses.length} response(s):`, ""];
    for (const r of responses) {
      lines.push(`ID: ${r.responseId} | Submitted: ${r.createTime} | Answers: ${Object.keys(r.answers || {}).length}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("get_form_response", "Get a specific form response with all answers.", {
    form_id: z.string(),
    response_id: z.string(),
  }, withErrorHandler(async ({ form_id, response_id }) => {
    const { accessToken } = await getCreds();
    const r = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}/responses/${response_id}`, accessToken) as any;
    const lines = [`Response ID: ${r.responseId}`, `Submitted: ${r.createTime}`, ""];
    for (const [questionId, answer] of Object.entries(r.answers || {})) {
      const textAnswers = (answer as any).textAnswers?.answers?.map((a: any) => a.value).join(", ");
      lines.push(`Q ${questionId}: ${textAnswers || JSON.stringify(answer)}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));
}

// ─── Additional tools to match upstream ──────────────────────────────────────

export function registerWorkspaceExtraTools(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_slide_page", "Get detailed information about a specific slide in a presentation.", {
    presentation_id: z.string(),
    page_object_id: z.string().describe("Page/slide object ID (from get_presentation)"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ presentation_id, page_object_id }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, `/pages/${page_object_id}`, "GET") as any;
    const texts = (data.pageElements || []).flatMap((el: any) => el.shape?.text?.textElements || []).map((te: any) => te.textRun?.content || "").join("").trim();
    const lines = [`Page: ${page_object_id}`, `Type: ${data.pageType || "SLIDE"}`, `Elements: ${data.pageElements?.length || 0}`, "", "Content:", texts || "(no text)"];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("get_slide_thumbnail", "Generate a thumbnail image URL for a specific slide.", {
    presentation_id: z.string(),
    page_object_id: z.string().describe("Page/slide object ID"),
    thumbnail_size: z.enum(["LARGE", "MEDIUM", "SMALL"]).optional().default("MEDIUM"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ presentation_id, page_object_id, thumbnail_size = "MEDIUM" }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ "thumbnailProperties.thumbnailSize": thumbnail_size });
    const data = await slidesRequest(accessToken, presentation_id, `/pages/${page_object_id}/thumbnail?${params}`, "GET") as any;
    return { content: [{ type: "text", text: `Thumbnail URL (${thumbnail_size}):\n${data.contentUrl}\n\nDimensions: ${data.width}×${data.height}` }] };
  }));

  server.tool("create_chat_reaction", "Add an emoji reaction to a Google Chat message.", {
    message_name: z.string().describe("Message name in format 'spaces/{space}/messages/{message}'"),
    emoji: z.string().describe("Unicode emoji character, e.g. '👍' or '🎉'"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ message_name, emoji }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://chat.googleapis.com/v1/${message_name}/reactions`, accessToken, "POST", {
      emoji: { unicode: emoji }
    }) as any;
    return { content: [{ type: "text", text: `Reaction ${emoji} added to message.\nReaction name: ${result.name}` }] };
  }));

  server.tool("download_chat_attachment", "Get metadata and download info for a Google Chat message attachment.", {
    attachment_name: z.string().describe("Attachment resource name, e.g. 'spaces/{space}/messages/{message}/attachments/{attachment}'"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ attachment_name }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://chat.googleapis.com/v1/${attachment_name}`, accessToken) as any;
    const lines = [
      `Attachment: ${data.name}`, `Filename: ${data.contentName || "N/A"}`,
      `Type: ${data.contentType || "N/A"}`, `Size: ${data.attachmentDataRef?.resourceName || "N/A"}`,
    ];
    if (data.downloadUri) lines.push(`Download URL: ${data.downloadUri}`);
    if (data.driveDataRef?.driveFileId) lines.push(`Drive File ID: ${data.driveDataRef.driveFileId}\nView: https://drive.google.com/file/d/${data.driveDataRef.driveFileId}/view`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("get_task_list", "Get details of a specific Google Task list.", {
    tasklist_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ tasklist_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${tasklist_id}`, accessToken) as any;
    return { content: [{ type: "text", text: `Task List: ${data.title}\nID: ${data.id}\nUpdated: ${data.updated || "N/A"}` }] };
  }));

  server.tool("set_form_publish_settings", "Configure publish settings for a Google Form (collecting emails, limiting responses, etc.).", {
    form_id: z.string(),
    collect_email: z.boolean().optional().describe("Require respondents to sign in with Google"),
    limit_responses: z.boolean().optional().describe("Limit to one response per user"),
    show_progress_bar: z.boolean().optional(),
    shuffle_questions: z.boolean().optional(),
    is_quiz: z.boolean().optional().describe("Set form as quiz mode"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ form_id, collect_email, limit_responses, show_progress_bar, shuffle_questions, is_quiz }) => {
    const { accessToken } = await getCreds();
    const settings: Record<string, unknown> = {};
    const fields: string[] = [];
    if (collect_email !== undefined) { settings.emailCollectionType = collect_email ? "VERIFIED" : "DO_NOT_COLLECT"; fields.push("emailCollectionType"); }
    if (limit_responses !== undefined) { settings.limitOneResponsePerUser = limit_responses; fields.push("limitOneResponsePerUser"); }
    if (show_progress_bar !== undefined) { settings.progressBar = { show_progress_bar }; fields.push("progressBar"); }
    if (shuffle_questions !== undefined) { settings.shuffleQuestions = shuffle_questions; fields.push("shuffleQuestions"); }
    const requests: any[] = [{ updateSettings: { settings: { quizSettings: is_quiz !== undefined ? { isQuiz: is_quiz } : undefined, ...settings }, updateMask: fields.join(",") } }];
    await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}:batchUpdate`, accessToken, "POST", { requests }) as any;
    return { content: [{ type: "text", text: `Form publish settings updated.\nApplied: ${fields.join(", ") || "quiz mode"}` }] };
  }));
}
