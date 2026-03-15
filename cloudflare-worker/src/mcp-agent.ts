/**
 * MCP Server handler — Google Workspace (Full tool coverage v2)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Env } from "./types";
import { extractSub, getValidAccessToken } from "./jwt";
import { registerGmailTools, registerGmailExtraTools } from "./tools/gmail";
import { registerCalendarTools } from "./tools/calendar";
import { registerDriveTools, registerDriveExtraTools } from "./tools/drive";
import { registerDocsTools, registerDocsExtraTools } from "./tools/docs";
import { registerSheetsTools, registerSheetsExtraTools } from "./tools/sheets";
import { registerContactsTools, registerContactsExtraTools } from "./tools/contacts";
import { registerAppsScriptTools, registerAppsScriptExtraTools } from "./tools/appsscript";
import { registerSearchTools } from "./tools/search";
import { registerSlidesExtendedTools } from "./tools/slides";
import {
  registerSlidesTools,
  registerChatTools,
  registerTasksTools,
  registerFormsTools,
  registerWorkspaceExtraTools,
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

  const server = new McpServer({ name: "mcp-google-workspace", version: "2.1.0" });
  const getCreds = async () => ({ accessToken });

  // ── Core tools ────────────────────────────────────────────────────────────────
  registerGmailTools(server, getCreds);         // 11 tools
  registerGmailExtraTools(server, getCreds);    // +3 tools (threads batch, filters)
  registerCalendarTools(server, getCreds);      // 8 tools
  registerDriveTools(server, getCreds);         // 15 tools
  registerDriveExtraTools(server, getCreds);    // +2 tools (download URL, public access)
  registerDocsTools(server, getCreds);          // 13 tools
  registerDocsExtraTools(server, getCreds);     // +8 tools (search, tabs, table, headers)
  registerSheetsTools(server, getCreds);        // 8 tools
  registerSheetsExtraTools(server, getCreds);   // +1 tool (conditional formatting)
  registerSlidesTools(server, getCreds);        // 5 tools
  registerSlidesExtendedTools(server, getCreds); // +18 Slides tools (dup, reorder, bg, notes, text, image, table)
  registerChatTools(server, getCreds);          // 4 tools
  registerTasksTools(server, getCreds);         // 9 tools
  registerFormsTools(server, getCreds);         // 5 tools
  registerContactsTools(server, getCreds);      // 11 tools
  registerContactsExtraTools(server, getCreds); // +1 tool (batch)
  registerAppsScriptTools(server, getCreds);    // 11 tools
  registerAppsScriptExtraTools(server, getCreds); // +5 tools (versions, delete, metrics)
  registerSearchTools(server, getCreds, env);   // 3 tools
  registerWorkspaceExtraTools(server, getCreds); // +6 tools (slides page/thumb, chat reaction/attach, task list, form settings)
  // ─────────────────────────────────────────────────────── Total: ~148 tools ──

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
