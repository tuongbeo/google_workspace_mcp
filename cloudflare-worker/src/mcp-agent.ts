/**
 * MCP Server handler — Google Workspace (Full tool coverage v2)
 *
 * Architecture: fresh McpServer per request (matches stable March 26 design).
 * Tool registration is fast (~1ms for 193 tools) so no meaningful overhead.
 * Avoids all singleton-related state issues with concurrent requests.
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
import { registerDocsAdvancedTools } from "./tools/docs-advanced";
import { registerDriveRevisionsTools } from "./tools/drive-revisions";
import { registerCompositeTools } from "./tools/composite";
import { registerSheetsPhase2Tools } from "./tools/sheets-phase2";
import { registerDocsPhase2Tools } from "./tools/docs-phase2";
import { registerSlidesPhase2Tools } from "./tools/slides-phase2";
import { registerAppsScriptPhase2Tools } from "./tools/appsscript-phase2";
import { registerConsolidatedTools } from "./tools/consolidated";
import { registerWriteGoogleDocTool } from "./tools/write-google-doc";
import { registerWriteGoogleSheetTool } from "./tools/write-google-sheet";
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
  // 24h grace period (86400s) for proxy JWT expiry.
  // Claude.ai's MCP proxy does NOT refresh tokens (Anthropic bug #228).
  // Without this, any expired proxy JWT → 401 → full connector disconnect.
  const sub = await extractSub(request, env.JWT_SECRET, 86400);
  if (!sub) {
    console.warn("[mcp] No valid sub in JWT — returning 401");
    return unauthorizedResponse(env.PUBLIC_BASE_URL);
  }

  // Diagnostic: log the JSON-RPC method being called
  try {
    const cloned = request.clone();
    const body = await cloned.json() as { method?: string } | Array<{ method?: string }>;
    const method = Array.isArray(body) ? body.map(m => m.method).join(",") : body.method;
    console.log(`[mcp] POST jsonrpc=${method} sub=${sub}`);
  } catch {
    console.log(`[mcp] POST (non-JSON body) sub=${sub}`);
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(
      sub,
      env.TOKENS_KV,
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
    );
  } catch (err) {
    console.error("[mcp] getValidAccessToken failed:", err);
    return unauthorizedResponse(env.PUBLIC_BASE_URL);
  }

  // Fresh McpServer per request — same design as stable March 26 build.
  // Avoids singleton state accumulation and race conditions with double-initialize.
  const server = new McpServer({
    name: "mcp-google-workspace",
    version: "2.1.0",
    category: "Productivity",
    logoUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/3840px-Google_%22G%22_logo.svg.png",
  } as any);

  const getCreds = async () => ({ accessToken });

  registerGmailTools(server, getCreds);
  registerGmailExtraTools(server, getCreds);
  registerCalendarTools(server, getCreds);
  registerDriveTools(server, getCreds);
  registerDriveExtraTools(server, getCreds);
  registerDocsTools(server, getCreds);
  registerDocsExtraTools(server, getCreds);
  registerSheetsTools(server, getCreds);
  registerSheetsExtraTools(server, getCreds);
  registerSlidesTools(server, getCreds);
  registerSlidesExtendedTools(server, getCreds);
  registerChatTools(server, getCreds);
  registerTasksTools(server, getCreds);
  registerFormsTools(server, getCreds);
  registerContactsTools(server, getCreds);
  registerContactsExtraTools(server, getCreds);
  registerAppsScriptTools(server, getCreds);
  registerAppsScriptExtraTools(server, getCreds);
  registerSearchTools(server, getCreds, env);
  registerWorkspaceExtraTools(server, getCreds);
  registerDocsAdvancedTools(server, getCreds);
  registerDriveRevisionsTools(server, getCreds);
  registerCompositeTools(server, getCreds);
  registerSheetsPhase2Tools(server, getCreds);
  registerDocsPhase2Tools(server, getCreds);
  registerSlidesPhase2Tools(server, getCreds);
  registerAppsScriptPhase2Tools(server, getCreds);
  registerConsolidatedTools(server, getCreds);
  registerWriteGoogleDocTool(server, getCreds);
  registerWriteGoogleSheetTool(server, getCreds);

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

  // NOTE: Do NOT call server.close() here.
  // With enableJsonResponse:true the transport buffers the full JSON response
  // before returning. Calling server.close() prematurely cancels the underlying
  // ReadableStream → Claude.ai receives truncated/closed SSE → disconnects.
  // server + transport are per-request and GC'd automatically after return.
  // Pattern confirmed stable in Jira/Confluence workers (same codebase).

  // Inject Mcp-Session-Id for stable session affinity in Claude.ai proxy.
  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", `google-workspace-${sub}`);
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
  return new Response(response.body, { status: response.status, headers });
}
