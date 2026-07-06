/**
 * Google Slides MCP Tools
 * Consolidated from: slides.ts, slides-phase2.ts, workspace.ts (slides sections)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { googleFetch, slidesRequest } from "../google";
import { withErrorHandler } from "../utils/tool-handler";
import { THEMES, FONT_PAIRS, deriveSlideTokens } from "../styles";
import type { GetCredsFunc } from "../types";
import type {
  SlidesPresentation, SlidesBatchUpdateResponse, SlidesSlide, SlidesThumbnail,
} from "./google-api-types";

function _registerSlidesCore(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_presentation", "Get details and slide content of a Google Slides presentation.", {
    presentation_id: z.string(),
  }, { readOnlyHint: true }, withErrorHandler(async ({ presentation_id }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as SlidesPresentation;
    const lines = [`# ${data.title}`, `ID: ${presentation_id}`, `Slides: ${data.slides?.length || 0}`, ""];
    for (const slide of (data.slides || [])) {
      const idx = slide.slideNumber || "?";
      const texts = (slide.pageElements || []).flatMap(el => el.shape?.text?.textElements || []).map(te => te.textRun?.content || "").join("").trim();
      if (texts) lines.push(`[Slide ${idx}] ${texts.substring(0, 200)}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }));

  server.tool("create_presentation", "Create a new Google Slides presentation.", {
    title: z.string(),
  }, { readOnlyHint: false }, withErrorHandler(async ({ title }) => {
    const { accessToken } = await getCreds();
    const result = await googleFetch("https://slides.googleapis.com/v1/presentations", accessToken, "POST", { title }) as SlidesPresentation;
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
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [insertReq] }) as SlidesBatchUpdateResponse;
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
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests }) as SlidesBatchUpdateResponse;
    return { content: [{ type: "text", text: `Batch update applied. ${result.replies?.length || 0} operations.` }] };
  }));

  server.tool("write_google_slide",
    "Create or update a Google Slides presentation from a structured outline. " +
    "6 themes (same as write_google_doc / write_google_sheet): corporate, modern, warm, nature, minimal, vibrant. " +
    "4 font pairs: open_roboto, raleway_noto, merriweather_open, mulish_nunito. " +
    "6 slide types: cover (dark bg + title + subtitle), section (dark bg + title), " +
    "bullets (header bar + bullet list), two_column (header bar + left/right bullets), " +
    "big_number (large stat + label), quote (dark bg + pull quote). " +
    "Create new: provide title + slides[]. Update existing: provide presentation_id + slides[] (appends slides).",
    {
      title: z.string().optional()
        .describe("Presentation title — required when creating new (no presentation_id)"),
      presentation_id: z.string().optional()
        .describe("Existing presentation ID — provide to append slides to existing presentation"),
      theme: z.enum(["corporate","modern","warm","nature","minimal","vibrant"])
        .optional().default("corporate")
        .describe("Visual theme — same palette as write_google_doc/write_google_sheet"),
      font_pair: z.enum(["open_roboto","raleway_noto","merriweather_open","mulish_nunito"])
        .optional().default("open_roboto")
        .describe("Font pair for headings and body text"),
      slides: z.array(z.object({
        type: z.enum(["cover","section","bullets","two_column","big_number","quote"]),
        title: z.string(),
        subtitle: z.string().optional(),
        bullets: z.array(z.string()).optional(),
        bullets_right: z.array(z.string()).optional(),
        stat: z.string().optional().describe("Large stat number for big_number slides"),
        stat_label: z.string().optional().describe("Caption below stat"),
        quote_text: z.string().optional().describe("Pull quote text"),
        quote_author: z.string().optional().describe("Quote attribution"),
        // Caps prevent a single call from building a batchUpdate request large
        // enough to exceed Slides' request limits or exhaust Worker CPU/memory.
      })).min(1).max(300),
    },
    { readOnlyHint: false },
    withErrorHandler(async ({ title, presentation_id, theme = "corporate", font_pair = "open_roboto", slides }) => {
      const { accessToken } = await getCreds();

      if (!presentation_id && !title) {
        throw new Error("Parameter 'title' is required when creating a new presentation (no presentation_id).");
      }

      // ── Resolve colors + fonts from styles/ system ───────────────────────
      const kc  = THEMES[theme] ?? THEMES.corporate;
      const fp  = FONT_PAIRS[font_pair as keyof typeof FONT_PAIRS] ?? FONT_PAIRS.open_roboto;
      const tok = deriveSlideTokens(kc, fp);

      // ── Presentation dimensions (16:9 standard) ───────────────────────────
      const W = 9144000, H = 5143500, M = 457200, CW = W - 2 * M;

      // ── Helper counter for unique object IDs ──────────────────────────────
      let _uidC = 0;
      function uid(p: string) { return `${p}_${++_uidC}_${Math.random().toString(36).slice(2,10)}`; }

      function rgbHex(hex: string) {
        const h = hex.replace('#', '');
        return { red: parseInt(h.slice(0,2),16)/255, green: parseInt(h.slice(2,4),16)/255, blue: parseInt(h.slice(4,6),16)/255 };
      }
      function bgReq(sid: string, hex: string) {
        return { updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgbHex(hex) } } } }, fields: 'pageBackgroundFill' } };
      }
      function tb(id: string, pid: string, x: number, y: number, w: number, h: number) {
        return { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: pid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } };
      }
      function rect(id: string, pid: string, x: number, y: number, w: number, h: number, hex: string) {
        return [
          { createShape: { objectId: id, shapeType: 'RECTANGLE', elementProperties: { pageObjectId: pid, size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } },
          { updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgbHex(hex) } } } }, fields: 'shapeBackgroundFill' } },
        ];
      }
      function ins(id: string, text: string) { return { insertText: { objectId: id, insertionIndex: 0, text } }; }
      function sty(id: string, s: number, e: number, o: { f?: string; sz?: number; c?: string; bold?: boolean; italic?: boolean }) {
        const style: Record<string,unknown> = {}, fields: string[] = [];
        if (o.f)   { style.fontFamily = o.f; fields.push('fontFamily'); }
        if (o.sz)  { style.fontSize = { magnitude: o.sz, unit: 'PT' }; fields.push('fontSize'); }
        if (o.c)   { style.foregroundColor = { opaqueColor: { rgbColor: rgbHex(o.c) } }; fields.push('foregroundColor'); }
        if (o.bold !== undefined)   { style.bold   = o.bold;   fields.push('bold'); }
        if (o.italic !== undefined) { style.italic = o.italic; fields.push('italic'); }
        return { updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: s, endIndex: e }, style, fields: fields.join(',') } };
      }
      function al(id: string, s: number, e: number, a: 'CENTER'|'START') {
        return { updateParagraphStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: s, endIndex: e }, style: { alignment: a }, fields: 'alignment' } };
      }

      // ── Colors from token system ──────────────────────────────────────────
      const darkBg   = tok.coverBg.replace('#','');      // cover + section bg
      const accentBg = tok.sectionBg.replace('#','');    // header bar on content slides
      const lightBg  = tok.defaultBg.replace('#','');    // content slide bg (white)
      const accentTxt = tok.sectionTitle.color.replace('#','');   // always white on dark
      const bodyClr  = tok.contentBody.color.replace('#','');
      const titleClr = tok.contentTitle.color.replace('#','');
      const subClr   = tok.coverSubtitle.color.replace('#','');

      // ── Font sizes (from token + sensible scale) ──────────────────────────
      const SZ = {
        coverTitle:  tok.coverTitle.fontSize,
        sectionTitle: tok.sectionTitle.fontSize,
        slideTitle:  tok.contentTitle.fontSize,
        bullet:      tok.contentBody.fontSize,
        subtitle:    tok.coverSubtitle.fontSize,
        stat:        56,
        body:        tok.contentBody.fontSize,
      };

      // ── Get or create presentation ────────────────────────────────────────
      let presId: string;
      let isCreate = !presentation_id;

      if (presentation_id) {
        presId = presentation_id;
      } else {
        const pres = await googleFetch("https://slides.googleapis.com/v1/presentations", accessToken, "POST", { title }) as SlidesPresentation;
        presId = pres.presentationId!;
        // Delete default blank slide when creating fresh
        const defSlide = pres.slides?.[0]?.objectId;
        if (defSlide) {
          await slidesRequest(accessToken, presId, ":batchUpdate", "POST", {
            requests: [{ deleteObject: { objectId: defSlide } }]
          });
        }
      }

      // ── Build slide requests ──────────────────────────────────────────────
      const reqs: any[] = [];

      for (const slide of slides) {
        const sid = uid('sl');
        reqs.push({ createSlide: { objectId: sid, slideLayoutReference: { predefinedLayout: 'BLANK' } } });

        if (slide.type === 'cover') {
          reqs.push(bgReq(sid, tok.coverBg));
          const tid = uid('t');
          reqs.push(
            tb(tid, sid, M, Math.round(H * .28), CW, Math.round(H * .28)),
            ins(tid, slide.title),
            sty(tid, 0, slide.title.length, { f: fp.heading, sz: SZ.coverTitle, c: accentTxt, bold: true }),
            al(tid, 0, slide.title.length, 'CENTER'),
          );
          if (slide.subtitle) {
            const subid = uid('s');
            reqs.push(
              tb(subid, sid, M, Math.round(H * .62), CW, Math.round(H * .18)),
              ins(subid, slide.subtitle),
              sty(subid, 0, slide.subtitle.length, { f: fp.body, sz: SZ.subtitle, c: subClr }),
              al(subid, 0, slide.subtitle.length, 'CENTER'),
            );
          }
        } else if (slide.type === 'section') {
          reqs.push(bgReq(sid, tok.sectionBg));
          const tid = uid('t');
          reqs.push(
            tb(tid, sid, M, Math.round(H * .33), CW, Math.round(H * .34)),
            ins(tid, slide.title),
            sty(tid, 0, slide.title.length, { f: fp.heading, sz: SZ.sectionTitle, c: accentTxt, bold: true }),
            al(tid, 0, slide.title.length, 'CENTER'),
          );
          if (slide.subtitle) {
            const subid = uid('s');
            reqs.push(
              tb(subid, sid, M, Math.round(H * .70), CW, Math.round(H * .15)),
              ins(subid, slide.subtitle),
              sty(subid, 0, slide.subtitle.length, { f: fp.body, sz: SZ.body, c: subClr }),
              al(subid, 0, slide.subtitle.length, 'CENTER'),
            );
          }
        } else if (slide.type === 'bullets' || slide.type === 'two_column') {
          reqs.push(bgReq(sid, lightBg));
          const barid = uid('bar');
          reqs.push(...rect(barid, sid, 0, 0, W, Math.round(H * .17), accentBg));
          const tid = uid('t');
          reqs.push(
            tb(tid, sid, M, Math.round(H * .03), CW, Math.round(H * .13)),
            ins(tid, slide.title),
            sty(tid, 0, slide.title.length, { f: fp.heading, sz: SZ.slideTitle, c: accentTxt, bold: true }),
          );
          if (slide.type === 'bullets' && slide.bullets?.length) {
            const bid = uid('b');
            const bt = slide.bullets.join('\n');
            reqs.push(tb(bid, sid, M, Math.round(H * .21), CW, Math.round(H * .70)), ins(bid, bt));
            let idx = 0;
            for (const b of slide.bullets) {
              reqs.push(sty(bid, idx, idx + b.length, { f: fp.body, sz: SZ.bullet, c: bodyClr }), al(bid, idx, idx + b.length, 'START'));
              idx += b.length + 1;
            }
          } else if (slide.type === 'two_column') {
            const cw = Math.round(CW * .46), gap = Math.round(CW * .08);
            if (slide.bullets?.length) {
              const lid = uid('l');
              const lt = slide.bullets.join('\n');
              reqs.push(tb(lid, sid, M, Math.round(H * .21), cw, Math.round(H * .70)), ins(lid, lt));
              let idx = 0;
              for (const b of slide.bullets) {
                reqs.push(sty(lid, idx, idx + b.length, { f: fp.body, sz: SZ.bullet, c: bodyClr }));
                idx += b.length + 1;
              }
            }
            if (slide.bullets_right?.length) {
              const rid = uid('r');
              const rt = slide.bullets_right.join('\n');
              reqs.push(tb(rid, sid, M + cw + gap, Math.round(H * .21), cw, Math.round(H * .70)), ins(rid, rt));
              let idx = 0;
              for (const b of slide.bullets_right) {
                reqs.push(sty(rid, idx, idx + b.length, { f: fp.body, sz: SZ.bullet, c: bodyClr }));
                idx += b.length + 1;
              }
            }
          }
        } else if (slide.type === 'big_number') {
          reqs.push(bgReq(sid, lightBg));
          const tid = uid('t');
          reqs.push(
            tb(tid, sid, M, Math.round(H * .07), CW, Math.round(H * .15)),
            ins(tid, slide.title),
            sty(tid, 0, slide.title.length, { f: fp.heading, sz: SZ.slideTitle, c: titleClr, bold: true }),
            al(tid, 0, slide.title.length, 'CENTER'),
          );
          if (slide.stat) {
            const s2 = uid('st');
            reqs.push(
              tb(s2, sid, M, Math.round(H * .27), CW, Math.round(H * .42)),
              ins(s2, slide.stat),
              sty(s2, 0, slide.stat.length, { f: fp.heading, sz: SZ.stat, c: titleClr, bold: true }),
              al(s2, 0, slide.stat.length, 'CENTER'),
            );
          }
          if (slide.stat_label) {
            const lid = uid('lb');
            reqs.push(
              tb(lid, sid, M, Math.round(H * .72), CW, Math.round(H * .15)),
              ins(lid, slide.stat_label),
              sty(lid, 0, slide.stat_label.length, { f: fp.body, sz: SZ.body, c: bodyClr }),
              al(lid, 0, slide.stat_label.length, 'CENTER'),
            );
          }
        } else if (slide.type === 'quote') {
          reqs.push(bgReq(sid, tok.coverBg));
          const qt = `"${slide.quote_text || slide.title}"`;
          const qid = uid('q');
          reqs.push(
            tb(qid, sid, M, Math.round(H * .2), CW, Math.round(H * .45)),
            ins(qid, qt),
            sty(qid, 0, qt.length, { f: fp.body, sz: SZ.subtitle, c: accentTxt, italic: true }),
            al(qid, 0, qt.length, 'CENTER'),
          );
          if (slide.quote_author) {
            const ad = `— ${slide.quote_author}`;
            const aid = uid('a');
            reqs.push(
              tb(aid, sid, M, Math.round(H * .70), CW, Math.round(H * .14)),
              ins(aid, ad),
              sty(aid, 0, ad.length, { f: fp.body, sz: SZ.body, c: subClr }),
              al(aid, 0, ad.length, 'CENTER'),
            );
          }
        }
      }

      await slidesRequest(accessToken, presId, ":batchUpdate", "POST", { requests: reqs });

      const presUrl = `https://docs.google.com/presentation/d/${presId}/edit`;
      return { content: [{ type: "text", text: [
        `Presentation ${isCreate ? "created" : "updated"}: "${title ?? presId}"`,
        `ID: ${presId}`,
        `Theme: ${theme} | Font: ${fp.heading} / ${fp.body}`,
        `Slides added: ${slides.length}`,
        `URL: ${presUrl}`,
        "",
        "Slide outline:",
        ...slides.map((s, i) => `  ${i + 1}. [${s.type}] ${s.title}`),
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

function _registerSlidesExtended(server: McpServer, getCreds: GetCredsFunc) {

  server.tool("duplicate_slide", "Duplicate an existing slide in a Google Slides presentation. Returns the new slide object ID.", {
    presentation_id: z.string(),
    slide_object_id: z.string().describe("Object ID of the slide to duplicate (from get_presentation)"),
    insertion_index: z.number().optional().describe("0-based index where the duplicate is inserted. Omit to insert after original."),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, insertion_index }) => {
    const { accessToken } = await getCreds();
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ duplicateObject: { objectId: slide_object_id } }],
    }) as SlidesBatchUpdateResponse;
    const newId = result.replies?.[0]?.duplicateObject?.objectId;
    // duplicateObject doesn't support positioning — move the duplicate afterward.
    if (insertion_index !== undefined && newId) {
      await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
        requests: [{ updateSlidesPosition: { slideObjectIds: [newId], insertionIndex: insertion_index } }],
      });
    }
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
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as SlidesPresentation;
    const slide = (data.slides || []).find(s => s.objectId === slide_object_id);
    if (!slide) return { content: [{ type: "text", text: `Slide not found: ${slide_object_id}` }] };
    const notes = slide.slideProperties?.notesPage;
    const notesTexts = (notes?.pageElements || []).flatMap(el => el.shape?.text?.textElements || []).map(te => te.textRun?.content || "").join("").trim();
    return { content: [{ type: "text", text: notesTexts ? `Speaker notes:\n${notesTexts}` : "No speaker notes on this slide." }] };
  }));

  server.tool("set_slide_notes", "Set (replace) the speaker notes on a slide.", {
    presentation_id: z.string(),
    slide_object_id: z.string(),
    notes_text: z.string().describe("Text content for speaker notes"),
  }, { readOnlyHint: false }, withErrorHandler(async ({ presentation_id, slide_object_id, notes_text }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, "", "GET") as SlidesPresentation;
    const slide = (data.slides || []).find(s => s.objectId === slide_object_id);
    if (!slide) return { content: [{ type: "text", text: `Slide not found: ${slide_object_id}` }] };
    const notesPage = slide.slideProperties?.notesPage;
    const notesShapeId = (notesPage?.pageElements || []).find(el => el.shape?.placeholder?.type === "BODY")?.objectId;
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
      // BUG-005 FIX: Use ABSOLUTE mode so x/y SET the position rather than ADD to existing position
      requests.push({ updatePageElementTransform: { objectId: object_id, transform, applyMode: "ABSOLUTE" } });
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
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", { requests: [req] }) as SlidesBatchUpdateResponse;
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
    if (!/^https?:\/\//i.test(image_url)) throw new Error("image_url must be an http(s) URL.");
    const { accessToken } = await getCreds();
    const imageId = object_id || `image_${Date.now()}`;
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ createImage: { objectId: imageId, url: image_url, elementProperties: { pageObjectId: slide_object_id, size: { height: { magnitude: height, unit: "EMU" }, width: { magnitude: width, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "EMU" } } } }],
    }) as SlidesBatchUpdateResponse;
    const newId = result.replies?.[0]?.createImage?.objectId || imageId;
    return { content: [{ type: "text", text: `Image inserted.\nImage ID: ${newId}\nURL: ${image_url}` }] };
  }));

  server.tool("replace_all_shapes_with_image", "Replace all shapes matching a tag text with an image URL across the presentation.", {
    presentation_id: z.string(),
    contains_text: z.string().describe("Text to match in shape (e.g. '{{hero_image}}')"),
    image_url: z.string(),
    image_replace_method: z.enum(["CENTER_INSIDE", "CENTER_CROP"]).optional().default("CENTER_INSIDE"),
  }, withErrorHandler(async ({ presentation_id, contains_text, image_url, image_replace_method = "CENTER_INSIDE" }) => {
    if (!/^https?:\/\//i.test(image_url)) throw new Error("image_url must be an http(s) URL.");
    const { accessToken } = await getCreds();
    const result = await slidesRequest(accessToken, presentation_id, ":batchUpdate", "POST", {
      requests: [{ replaceAllShapesWithImage: { imageUrl: image_url, imageReplaceMethod: image_replace_method, containsText: { text: contains_text, matchCase: false } } }],
    }) as SlidesBatchUpdateResponse;
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
    }) as SlidesBatchUpdateResponse;
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

function _registerSlidesPhase2(server: McpServer, getCreds: GetCredsFunc) {

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

      const lineCatMap: Record<string, string> = {
        STRAIGHT: "STRAIGHT",
        BENT:     "BENT",
        CURVED:   "CURVED",
      };
      // Arrow style mapping to Slides API ArrowStyle enum
      const arrowMap: Record<string, string> = {
        NONE:    "NONE",
        ARROW:   "FILL_ARROW",
        OPEN:    "OPEN_ARROW",
        STEALTH: "STEALTH_ARROW",
        DIAMOND: "FILL_DIAMOND",
        CIRCLE:  "FILL_CIRCLE",
      };

      const requests: any[] = [
        {
          createLine: {
            objectId,
            lineCategory: lineCatMap[line_type] || "STRAIGHT",
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
        startArrow: arrowMap[start_arrow] || "NONE",
        endArrow:   arrowMap[end_arrow]   || "NONE",
      };
      const fields = ["dashStyle","weight","startArrow","endArrow"].join(",");
      if (color) lineProps.lineFill = solidFill(color);

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
        shapeProps.shadow = { propertyState: shadow ? "RENDERED" : "NOT_RENDERED" };
        fields.push("shadow.propertyState");
      }

      if (!fields.length) return { content: [{ type: "text", text: "No changes specified." }] };

      await slidesBatch(accessToken, presentation_id, [{
        updateShapeProperties: { objectId: object_id, shapeProperties: shapeProps, fields: fields.join(",") },
      }]);
      return { content: [{ type: "text", text: `Shape ${object_id} properties updated.` }] };
    }),
  );

} // end registerSlidesPhase2Tools


function _registerSlidesPage(server: McpServer, getCreds: GetCredsFunc) {
  server.tool("get_slide_page", "Get detailed information about a specific slide in a presentation.", {
    presentation_id: z.string(),
    page_object_id: z.string().describe("Page/slide object ID (from get_presentation)"),
  }, { readOnlyHint: true }, withErrorHandler(async ({ presentation_id, page_object_id }) => {
    const { accessToken } = await getCreds();
    const data = await slidesRequest(accessToken, presentation_id, `/pages/${page_object_id}`, "GET") as SlidesSlide;
    const texts = (data.pageElements || []).flatMap(el => el.shape?.text?.textElements || []).map(te => te.textRun?.content || "").join("").trim();
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
    const data = await slidesRequest(accessToken, presentation_id, `/pages/${page_object_id}/thumbnail?${params}`, "GET") as SlidesThumbnail;
    return { content: [{ type: "text", text: `Thumbnail URL (${thumbnail_size}):\n${data.contentUrl}\n\nDimensions: ${data.width}×${data.height}` }] };
  }));
}
// ── Unified entry point ───────────────────────────────────────────────────────

export function registerSlidesTools(server: McpServer, getCreds: GetCredsFunc): void {
  _registerSlidesCore(server, getCreds);
  _registerSlidesExtended(server, getCreds);
  _registerSlidesPhase2(server, getCreds);
  _registerSlidesPage(server, getCreds);
}
