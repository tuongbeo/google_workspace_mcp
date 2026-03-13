/**
 * Google Custom Search (Programmable Search Engine) MCP Tools
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../types";

type GetCredsFunc = () => Promise<{ accessToken: string }>;

export function registerSearchTools(server: McpServer, _getCreds: GetCredsFunc, env: Env) {

  server.tool("search_custom", "Search the web using Google Programmable Search Engine.", {
    query: z.string().describe("Search query"),
    num: z.number().optional().default(10).describe("Number of results (max 10)"),
    start: z.number().optional().default(1).describe("Start index for pagination"),
    language: z.string().optional().describe("Language code, e.g. 'lang_vi'"),
    safe: z.enum(["active", "off"]).optional().default("off"),
    sort: z.string().optional().describe("Sort expression, e.g. 'date'"),
  }, async ({ query, num = 10, start = 1, language, safe = "off", sort }) => {
    if (!env.GOOGLE_PSE_API_KEY || !env.GOOGLE_PSE_ENGINE_ID) {
      return { content: [{ type: "text", text: "Custom Search not configured. Set GOOGLE_PSE_API_KEY and GOOGLE_PSE_ENGINE_ID in Worker secrets." }] };
    }
    const params = new URLSearchParams({
      key: env.GOOGLE_PSE_API_KEY,
      cx: env.GOOGLE_PSE_ENGINE_ID,
      q: query,
      num: String(Math.min(num, 10)),
      start: String(start),
      safe,
    });
    if (language) params.set("lr", language);
    if (sort) params.set("sort", sort);
    const resp = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!resp.ok) throw new Error(`Search failed: ${await resp.text()}`);
    const data = await resp.json() as any;
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: `No results for: "${query}"` }] };
    const totalResults = data.searchInformation?.totalResults || "?";
    const lines = [`Search: "${query}" — ${totalResults} total results`, ""];
    for (const item of items) {
      lines.push(`**${item.title}**`);
      lines.push(item.link);
      if (item.snippet) lines.push(item.snippet);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("search_custom_siterestrict", "Search within specific domains using Google Custom Search.", {
    query: z.string(),
    site_search: z.string().describe("Domain to restrict search, e.g. 'docs.anthropic.com'"),
    num: z.number().optional().default(10),
  }, async ({ query, site_search, num = 10 }) => {
    if (!env.GOOGLE_PSE_API_KEY || !env.GOOGLE_PSE_ENGINE_ID) {
      return { content: [{ type: "text", text: "Custom Search not configured." }] };
    }
    const params = new URLSearchParams({
      key: env.GOOGLE_PSE_API_KEY,
      cx: env.GOOGLE_PSE_ENGINE_ID,
      q: query,
      siteSearch: site_search,
      num: String(Math.min(num, 10)),
    });
    const resp = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!resp.ok) throw new Error(`Search failed: ${await resp.text()}`);
    const data = await resp.json() as any;
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: `No results for "${query}" on ${site_search}` }] };
    const lines = [`Search "${query}" on ${site_search}:`, ""];
    for (const item of items) {
      lines.push(`**${item.title}**\n${item.link}\n${item.snippet || ""}`);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("get_search_engine_info", "Get info about the configured Programmable Search Engine.", {}, async () => {
    if (!env.GOOGLE_PSE_API_KEY || !env.GOOGLE_PSE_ENGINE_ID) {
      return { content: [{ type: "text", text: "Custom Search not configured." }] };
    }
    const resp = await fetch(`https://www.googleapis.com/customsearch/v1/cse?key=${env.GOOGLE_PSE_API_KEY}&cx=${env.GOOGLE_PSE_ENGINE_ID}`);
    if (!resp.ok) throw new Error(`API error: ${await resp.text()}`);
    const data = await resp.json() as any;
    return { content: [{ type: "text", text: `Search Engine: ${data.title || "N/A"}\nCX: ${env.GOOGLE_PSE_ENGINE_ID}\nKind: ${data.kind || "N/A"}` }] };
  });
}
