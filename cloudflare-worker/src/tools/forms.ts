/**
 * Google Forms MCP Tools
 * Extracted from workspace.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import type { GetCredsFunc } from "../types";
import type {
  Form, FormBatchUpdateResponse, FormResponse, FormResponseListResponse,
} from "./google-api-types";

function _registerForms(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_form", "Get details, structure, settings, and linked spreadsheet of a Google Form.", {
    form_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ form_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}`, accessToken) as Form;
    const settings = data.settings || {};
    const lines = [
      `Form: ${data.info?.title}`,
      `ID: ${data.formId}`,
      `Description: ${data.info?.description || "N/A"}`,
      `Document title: ${data.info?.documentTitle || "N/A"}`,
      `Responder URI: ${data.responderUri || "N/A"}`,
      `Items: ${data.items?.length || 0}`,
      "",
      "Settings:",
      `  Email collection: ${settings.emailCollectionType || "DO_NOT_COLLECT"}`,
      `  One response per user: ${settings.limitOneResponsePerUser ?? false}`,
      `  Show progress bar: ${settings.progressBar ?? false}`,
      `  Shuffle questions: ${settings.shuffleQuestions ?? false}`,
      `  Confirmation message: ${settings.confirmationMessage?.text || "(default)"}`,
    ];
    if (settings.quizSettings?.isQuiz) {
      lines.push(`  Quiz mode: true`);
      const qs = settings.quizSettings;
      if (qs.autoScore !== undefined) lines.push(`  Auto-score: ${qs.autoScore}`);
      if (qs.defaultFeedback?.text) lines.push(`  Default quiz feedback: ${qs.defaultFeedback.text}`);
    }
    if (data.linkedSheetId) {
      lines.push(`\nLinked Google Sheet:`);
      lines.push(`  ID: ${data.linkedSheetId}`);
      lines.push(`  URL: https://docs.google.com/spreadsheets/d/${data.linkedSheetId}/edit`);
    }
    if (data.items?.length) {
      lines.push("\nQuestions:");
      for (const item of data.items) {
        if (item.questionItem) {
          const q = item.questionItem.question;
          const type = q.textQuestion ? "TEXT" : q.choiceQuestion ? `CHOICE(${q.choiceQuestion.type})` : q.scaleQuestion ? "SCALE" : q.dateQuestion ? "DATE" : q.timeQuestion ? "TIME" : q.fileUploadQuestion ? "FILE_UPLOAD" : q.rowQuestion ? "ROW" : "OTHER";
          const required = q.required ? "*" : "";
          lines.push(`  - [${type}${required}] ${item.title || "Untitled"} (ID: ${item.itemId})`);
          if (q.choiceQuestion?.options) {
            lines.push(`    Options: ${q.choiceQuestion.options.map(o => o.value).join(", ")}`);
          }
          if (q.scaleQuestion) {
            lines.push(`    Scale: ${q.scaleQuestion.low} (${q.scaleQuestion.lowLabel || ""}) → ${q.scaleQuestion.high} (${q.scaleQuestion.highLabel || ""})`);
          }
        } else if (item.questionGroupItem) {
          lines.push(`  - [QUESTION_GROUP] ${item.title || "Untitled"} (${item.questionGroupItem.questions?.length || 0} sub-questions)`);
        } else if (item.pageBreakItem) {
          lines.push(`  - [PAGE_BREAK] ${item.title || ""}`);
        } else if (item.textItem) {
          lines.push(`  - [TEXT_BLOCK] ${item.title || ""}`);
        } else if (item.imageItem) {
          lines.push(`  - [IMAGE] ${item.title || ""}`);
        }
      }
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
    const result = await googleFetch("https://forms.googleapis.com/v1/forms", accessToken, "POST", { info }) as Form;
    return { content: [{ type: "text", text: `Form created: "${result.info?.title}"\nID: ${result.formId}\nEdit: https://docs.google.com/forms/d/${result.formId}/edit\nRespond: ${result.responderUri}` }] };
  }));

  server.tool("batch_update_form", "Apply batch updates to a Google Form (add/modify questions, settings).", {
    form_id: z.string(),
    requests: z.array(z.record(z.any())).describe("Array of Forms API batchUpdate request objects"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ form_id, requests }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}:batchUpdate`, accessToken, "POST", { requests }) as FormBatchUpdateResponse;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations.` }] };
  }));

  server.tool("list_form_responses", "List responses to a Google Form.", {
    form_id: z.string(),
    page_size: z.number().optional().default(10),
  }, withErrorHandler(async ({ form_id, page_size = 10 }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}/responses?pageSize=${page_size}`, accessToken) as FormResponseListResponse;
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
    const r = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}/responses/${response_id}`, accessToken) as FormResponse;
    const lines = [`Response ID: ${r.responseId}`, `Submitted: ${r.createTime}`, ""];
    for (const [questionId, answer] of Object.entries(r.answers || {})) {
      const textAnswers = answer.textAnswers?.answers?.map(a => a.value).join(", ");
      lines.push(`Q ${questionId}: ${textAnswers || JSON.stringify(answer)}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));
}

function _registerFormSettings(server: McpServer, getCreds: GetCredsFunc) {
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
    if (show_progress_bar !== undefined) { settings.progressBar = show_progress_bar; fields.push("progressBar"); }
    if (shuffle_questions !== undefined) { settings.shuffleQuestions = shuffle_questions; fields.push("shuffleQuestions"); }
    if (is_quiz !== undefined) { settings.quizSettings = { isQuiz: is_quiz }; fields.push("quizSettings.isQuiz"); }
    const requests: any[] = [{ updateSettings: { settings, updateMask: fields.join(",") } }];
    await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}:batchUpdate`, accessToken, "POST", { requests });
    return { content: [{ type: "text", text: `Form publish settings updated.\nApplied: ${fields.join(", ") || "quiz mode"}` }] };
  }));
}
export function registerFormsTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerForms(server, getCreds);
  _registerFormSettings(server, getCreds);
}
