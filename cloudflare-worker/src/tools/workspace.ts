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

  server.tool("create_presentation_from_outline",
    "Create a professional Google Slides presentation from a structured outline. " +
    "Applies Anthropic PPTX design standards: 16:9 layout, consistent typography scale, " +
    "10 color palettes and 4 font pairings from Anthropic PPTX skill, " +
    "dark cover/section slides with light content slides (sandwich structure).",
    {
      title: z.string(),
      theme: z.enum(["midnight_executive","ocean_gradient","forest_moss","coral_energy","charcoal_minimal","teal_trust","warm_terracotta"])
        .optional().default("midnight_executive")
        .describe("Color palette: midnight_executive=navy/ice-blue, ocean_gradient=deep-blue/teal, forest_moss=green, coral_energy=coral/navy, charcoal_minimal=dark-gray, teal_trust=teal/seafoam, warm_terracotta=terracotta/sand"),
      font_pair: z.enum(["arial_black_arial","georgia_calibri","calibri","trebuchet_calibri"])
        .optional().default("arial_black_arial")
        .describe("Font pairing: arial_black_arial=bold modern, georgia_calibri=classic editorial, calibri=clean corporate, trebuchet_calibri=friendly"),
      slides: z.array(z.object({
        type: z.enum(["cover","section","bullets","two_column","big_number","quote"]),
        title: z.string(),
        subtitle: z.string().optional(),
        bullets: z.array(z.string()).optional(),
        bullets_right: z.array(z.string()).optional(),
        stat: z.string().optional(),
        stat_label: z.string().optional(),
        quote_text: z.string().optional(),
        quote_author: z.string().optional(),
      })).min(1),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ title, theme = "midnight_executive", font_pair = "arial_black_arial", slides }) => {
      const { accessToken } = await getCreds();

      // Design tokens from Anthropic PPTX skill SKILL.md (exact hex values)
      const PALETTES: Record<string, { p: string; s: string }> = {
        midnight_executive: { p: '1E2761', s: 'CADCFC' },
        forest_moss:        { p: '2C5F2D', s: '97BC62' },
        coral_energy:       { p: 'F96167', s: 'F9E795' },
        ocean_gradient:     { p: '065A82', s: '1C7293' },
        charcoal_minimal:   { p: '36454F', s: 'F2F2F2' },
        teal_trust:         { p: '028090', s: '00A896' },
        warm_terracotta:    { p: 'B85042', s: 'E7E8D1' },
      };
      // Exact font names from Anthropic PPTX skill SKILL.md
      const FONTS: Record<string, { h: string; b: string }> = {
        arial_black_arial:  { h: 'Arial Black',  b: 'Arial'         },
        georgia_calibri:    { h: 'Georgia',       b: 'Calibri'       },
        calibri:            { h: 'Calibri',        b: 'Calibri Light' },
        trebuchet_calibri:  { h: 'Trebuchet MS',  b: 'Calibri'       },
      };
      // Typography scale from PPTX SKILL.md: title=36-44pt, section=20-24pt, body=14-16pt, caption=10-12pt
      const SZ = { coverTitle: 40, section: 36, slideTitle: 26, body: 16, bullet: 15, stat: 60, subtitle: 22, caption: 11 };
      // Layout: 16:9 = 10"×5.625" = 9144000×5143500 EMU (pptxgenjs.md: "LAYOUT_16x9: 10"×5.625"")
      const W = 9144000, H = 5143500, M = 457200, CW = W - 2*M;

      const pal = PALETTES[theme];
      const fnt = FONTS[font_pair];

      function rgb(hex: string) { return { red: parseInt(hex.slice(0,2),16)/255, green: parseInt(hex.slice(2,4),16)/255, blue: parseInt(hex.slice(4,6),16)/255 }; }
      function bg(sid: string, hex: string) { return { updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb(hex) } } } }, fields: 'pageBackgroundFill' } }; }
      function uid(p: string) { return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`; }
      function tb(id: string, pid: string, x: number, y: number, w: number, h: number) {
        return { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: pid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } };
      }
      function rect(id: string, pid: string, x: number, y: number, w: number, h: number, hex: string) {
        return [
          { createShape: { objectId: id, shapeType: 'RECTANGLE', elementProperties: { pageObjectId: pid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
          { updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(hex) } } } }, fields: 'shapeBackgroundFill' } },
        ];
      }
      function ins(id: string, text: string) { return { insertText: { objectId: id, insertionIndex: 0, text } }; }
      function sty(id: string, s: number, e: number, opts: { f?: string; sz?: number; c?: string; bold?: boolean; italic?: boolean }) {
        const style: Record<string,unknown> = {};
        const fields: string[] = [];
        if (opts.f)    { style.fontFamily = opts.f; fields.push('fontFamily'); }
        if (opts.sz)   { style.fontSize = { magnitude: opts.sz, unit: 'PT' }; fields.push('fontSize'); }
        if (opts.c)    { style.foregroundColor = { opaqueColor: { rgbColor: rgb(opts.c) } }; fields.push('foregroundColor'); }
        if (opts.bold !== undefined)   { style.bold   = opts.bold;   fields.push('bold'); }
        if (opts.italic !== undefined) { style.italic = opts.italic; fields.push('italic'); }
        return { updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: s, endIndex: e }, style, fields: fields.join(',') } };
      }
      function align(id: string, s: number, e: number, a: 'CENTER'|'START') {
        return { updateParagraphStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: s, endIndex: e }, style: { alignment: a }, fields: 'alignment' } };
      }

      const pres = await googleFetch("https://slides.googleapis.com/v1/presentations", accessToken, "POST", { title }) as any;
      const presId: string = pres.presentationId;
      const defSlide = pres.slides?.[0]?.objectId;
      const reqs: any[] = [];
      if (defSlide) reqs.push({ deleteObject: { objectId: defSlide } });

      for (const slide of slides) {
        const sid = uid('sl');
        reqs.push({ createSlide: { objectId: sid, slideLayoutReference: { predefinedLayout: 'BLANK' } } });

        if (slide.type === 'cover') {
          // PPTX skill: dark bg for title/cover slides
          reqs.push(bg(sid, pal.p));
          const tid = uid('t'); reqs.push(tb(tid, sid, M, Math.round(H*0.28), CW, Math.round(H*0.28)), ins(tid, slide.title), sty(tid, 0, slide.title.length, { f: fnt.h, sz: SZ.coverTitle, c: 'FFFFFF', bold: true }), align(tid, 0, slide.title.length, 'CENTER'));
          if (slide.subtitle) { const subid = uid('s'); reqs.push(tb(subid, sid, M, Math.round(H*0.62), CW, Math.round(H*0.18)), ins(subid, slide.subtitle), sty(subid, 0, slide.subtitle.length, { f: fnt.b, sz: SZ.subtitle, c: pal.s }), align(subid, 0, slide.subtitle.length, 'CENTER')); }

        } else if (slide.type === 'section') {
          reqs.push(bg(sid, pal.p));
          const tid = uid('t'); reqs.push(tb(tid, sid, M, Math.round(H*0.33), CW, Math.round(H*0.34)), ins(tid, slide.title), sty(tid, 0, slide.title.length, { f: fnt.h, sz: SZ.section, c: 'FFFFFF', bold: true }), align(tid, 0, slide.title.length, 'CENTER'));
          if (slide.subtitle) { const subid = uid('s'); reqs.push(tb(subid, sid, M, Math.round(H*0.70), CW, Math.round(H*0.15)), ins(subid, slide.subtitle), sty(subid, 0, slide.subtitle.length, { f: fnt.b, sz: SZ.body, c: pal.s }), align(subid, 0, slide.subtitle.length, 'CENTER')); }

        } else if (slide.type === 'bullets' || slide.type === 'two_column') {
          // PPTX skill: light bg for content slides; top accent bar (NOT a line under title)
          reqs.push(bg(sid, 'FFFFFF'));
          const barid = uid('bar'); reqs.push(...rect(barid, sid, 0, 0, W, Math.round(H*0.17), pal.p));
          const tid = uid('t'); reqs.push(tb(tid, sid, M, Math.round(H*0.03), CW, Math.round(H*0.13)), ins(tid, slide.title), sty(tid, 0, slide.title.length, { f: fnt.h, sz: SZ.slideTitle, c: 'FFFFFF', bold: true }));

          if (slide.type === 'bullets' && slide.bullets?.length) {
            const bid = uid('b'); const bt = slide.bullets.join('\n');
            reqs.push(tb(bid, sid, M, Math.round(H*0.21), CW, Math.round(H*0.70)), ins(bid, bt));
            let idx = 0;
            for (const b of slide.bullets) { reqs.push(sty(bid, idx, idx+b.length, { f: fnt.b, sz: SZ.bullet, c: '1F2937' }), align(bid, idx, idx+b.length, 'START')); idx += b.length+1; }
          } else if (slide.type === 'two_column') {
            const cw = Math.round(CW*0.46), gap = Math.round(CW*0.08);
            if (slide.bullets?.length) {
              const lid = uid('l'); const lt = slide.bullets.join('\n');
              reqs.push(tb(lid, sid, M, Math.round(H*0.21), cw, Math.round(H*0.70)), ins(lid, lt));
              let idx = 0; for (const b of slide.bullets) { reqs.push(sty(lid, idx, idx+b.length, { f: fnt.b, sz: SZ.bullet, c: '1F2937' })); idx += b.length+1; }
            }
            if (slide.bullets_right?.length) {
              const rid = uid('r'); const rt = slide.bullets_right.join('\n');
              reqs.push(tb(rid, sid, M+cw+gap, Math.round(H*0.21), cw, Math.round(H*0.70)), ins(rid, rt));
              let idx = 0; for (const b of slide.bullets_right) { reqs.push(sty(rid, idx, idx+b.length, { f: fnt.b, sz: SZ.bullet, c: '1F2937' })); idx += b.length+1; }
            }
          }

        } else if (slide.type === 'big_number') {
          // PPTX skill: "Large stat callouts (big numbers 60-72pt with small labels below)"
          reqs.push(bg(sid, 'FFFFFF'));
          const tid = uid('t'); reqs.push(tb(tid, sid, M, Math.round(H*0.07), CW, Math.round(H*0.15)), ins(tid, slide.title), sty(tid, 0, slide.title.length, { f: fnt.h, sz: SZ.slideTitle, c: pal.p, bold: true }), align(tid, 0, slide.title.length, 'CENTER'));
          if (slide.stat) { const sid2 = uid('st'); reqs.push(tb(sid2, sid, M, Math.round(H*0.27), CW, Math.round(H*0.42)), ins(sid2, slide.stat), sty(sid2, 0, slide.stat.length, { f: fnt.h, sz: SZ.stat, c: pal.p, bold: true }), align(sid2, 0, slide.stat.length, 'CENTER')); }
          if (slide.stat_label) { const lid = uid('lb'); reqs.push(tb(lid, sid, M, Math.round(H*0.72), CW, Math.round(H*0.15)), ins(lid, slide.stat_label), sty(lid, 0, slide.stat_label.length, { f: fnt.b, sz: SZ.body, c: '6B7280' }), align(lid, 0, slide.stat_label.length, 'CENTER')); }

        } else if (slide.type === 'quote') {
          reqs.push(bg(sid, pal.p));
          const qt = `"${slide.quote_text || slide.title}"`;
          const qid = uid('q'); reqs.push(tb(qid, sid, M, Math.round(H*0.2), CW, Math.round(H*0.45)), ins(qid, qt), sty(qid, 0, qt.length, { f: fnt.b, sz: SZ.subtitle, c: 'FFFFFF', italic: true }), align(qid, 0, qt.length, 'CENTER'));
          if (slide.quote_author) { const ad = `— ${slide.quote_author}`; const aid = uid('a'); reqs.push(tb(aid, sid, M, Math.round(H*0.70), CW, Math.round(H*0.14)), ins(aid, ad), sty(aid, 0, ad.length, { f: fnt.b, sz: SZ.body, c: pal.s }), align(aid, 0, ad.length, 'CENTER')); }
        }
      }

      await slidesRequest(accessToken, presId, ":batchUpdate", "POST", { requests: reqs });
      return { content: [{ type: "text", text: [
        `Presentation created: "${title}"`,
        `ID: ${presId}`,
        `Theme: ${theme} | Fonts: ${fnt.h} / ${fnt.b}`,
        `Slides: ${slides.length}`,
        `URL: https://docs.google.com/presentation/d/${presId}/edit`,
        "",
        "Slide outline:",
        ...slides.map((s,i) => `  ${i+1}. [${s.type}] ${s.title}`),
      ].join("\n") }] };
    })
  );

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

  server.tool("get_chat_messages", "Get messages from a Google Chat space with optional time and sender filters.", {
    space_name: z.string().describe("Space name in format 'spaces/{spaceId}'"),
    page_size: z.number().optional().default(20),
    filter: z.string().optional().describe("API filter string, e.g. 'createTime > \"2025-01-01T00:00:00Z\"' or 'sender.name = \"users/123\"'"),
    order_by: z.enum(["createTime asc", "createTime desc"]).optional().default("createTime desc"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ space_name, page_size = 20, filter, order_by = "createTime desc" }) => {
    const { accessToken } = await getCreds();
    const params = new URLSearchParams({ pageSize: String(page_size), orderBy: order_by });
    if (filter) params.set("filter", filter);
    const data = await googleFetch(`https://chat.googleapis.com/v1/${space_name}/messages?${params}`, accessToken) as any;
    const messages = order_by === "createTime desc" ? (data.messages || []).reverse() : (data.messages || []);
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

  server.tool("search_chat_messages", "Search messages across Google Chat spaces, with optional createTime filter.", {
    query: z.string().describe("Full-text search query"),
    page_size: z.number().optional().default(20),
    create_time_after: z.string().optional().describe("ISO 8601 datetime — only return messages after this time, e.g. '2025-01-01T00:00:00Z'"),
    create_time_before: z.string().optional().describe("ISO 8601 datetime — only return messages before this time"),
    space_name: z.string().optional().describe("Limit to a specific space, e.g. 'spaces/{spaceId}'"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ query, page_size = 20, create_time_after, create_time_before, space_name }) => {
    const { accessToken } = await getCreds();
    const filters: string[] = [];
    if (create_time_after) filters.push(`createTime > "${create_time_after}"`);
    if (create_time_before) filters.push(`createTime < "${create_time_before}"`);
    if (space_name) filters.push(`spaces/${space_name.replace(/^spaces\//, "")}`);
    const params = new URLSearchParams({ query, pageSize: String(Math.min(page_size, 25)) });
    if (filters.length) params.set("filter", filters.join(" AND "));
    const data = await googleFetch(`https://chat.googleapis.com/v1/spaces/messages:search?${params}`, accessToken) as any;
    const messages = data.messages || [];
    if (!messages.length) return { content: [{ type: "text", text: `No messages found for: "${query}"` }] };
    const lines = messages.map((m: any) =>
      `[${m.createTime}] ${m.sender?.displayName || m.sender?.name}: ${m.text || "(media)"}\nSpace: ${m.space?.name || m.name?.split("/messages/")[0] || "?"}`
    );
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
  server.tool("get_form", "Get details, structure, settings, and linked spreadsheet of a Google Form.", {
    form_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ form_id }) => {
    const { accessToken } = await getCreds();
    const data = await googleFetch(`https://forms.googleapis.com/v1/forms/${form_id}`, accessToken) as any;
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
            lines.push(`    Options: ${q.choiceQuestion.options.map((o: any) => o.value).join(", ")}`);
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
