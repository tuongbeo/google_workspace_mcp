/**
 * MCP Server handler — Google Workspace (Full tool coverage)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Env } from "./types";
import { extractSub, getValidAccessToken } from "./jwt";
import { registerGmailTools } from "./tools/gmail";
import { registerCalendarTools } from "./tools/calendar";
import { registerDriveTools } from "./tools/drive";
import { registerDocsTools } from "./tools/docs";
import { registerSheetsTools } from "./tools/sheets";
import { registerContactsTools } from "./tools/contacts";
import { registerAppsScriptTools } from "./tools/appsscript";
import { registerSearchTools } from "./tools/search";
import {
  registerSlidesTools,
  registerChatTools,
  registerTasksTools,
  registerFormsTools,
} from "./tools/workspace";

function unauthorizedResponse(publicBaseUrl: string): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Token expired or revoked. Please re-authenticate." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": [`Bearer realm="${publicBaseUrl}"`, `resource_metadata_url="${publicBaseUrl}/.well-known/oauth-protected-resource"`].join(", "),
      },
    }
  );
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const sub = await extractSub(request, env.JWT_SECRET);
  if (!sub) return unauthorizedResponse(env.PUBLIC_BASE_URL);

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(
      sub,
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      "",
      env.OAUTH_KV
    );
  } catch (err) {
    console.error("[mcp-agent] getValidAccessToken failed:", err);
    return unauthorizedResponse(env.PUBLIC_BASE_URL);
  }

  const server = new McpServer({ name: "mcp-google-workspace", version: "2.0.0" });
  const getCreds = async () => ({ accessToken });

  // ── Register all tools ────────────────────────────────────────────────────────
  registerGmailTools(server, getCreds);        // Gmail: 10 tools
  registerCalendarTools(server, getCreds);     // Calendar: 8 tools
  registerDriveTools(server, getCreds);        // Drive: 14 tools
  registerDocsTools(server, getCreds);         // Docs: 12 tools
  registerSheetsTools(server, getCreds);       // Sheets: 8 tools
  registerSlidesTools(server, getCreds);       // Slides: 5 tools
  registerChatTools(server, getCreds);         // Chat: 4 tools
  registerTasksTools(server, getCreds);        // Tasks: 9 tools
  registerFormsTools(server, getCreds);        // Forms: 5 tools
  registerContactsTools(server, getCreds);     // Contacts: 12 tools
  registerAppsScriptTools(server, getCreds);   // Apps Script: 11 tools
  registerSearchTools(server, getCreds, env);  // Custom Search: 3 tools
  // ─────────────────────────────────────────────────────── Total: ~101 tools ──

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  const patchedRequest = new Request(request, {
    headers: (() => {
      const h = new Headers(request.headers);
      const existing = h.get("accept") || "";
      if (!existing.includes("application/json") || !existing.includes("text/event-stream")) {
        h.set("accept", "application/json, text/event-stream");
      }
      return h;
    })(),
  });

  const response = await transport.handleRequest(patchedRequest);
  await server.close();
  return response;
}
