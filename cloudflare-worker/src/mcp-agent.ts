/**
 * MCP Server handler — Google Workspace (Full tool coverage v2)
 *
 * Performance optimisation: McpServer + tool registration happens once at
 * module load time (warm isolate reuse). Only the getCreds closure — which
 * captures the per-request access token — is request-scoped.
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
import {
  registerSlidesTools,
  registerChatTools,
  registerTasksTools,
  registerFormsTools,
  registerWorkspaceExtraTools,
} from "./tools/workspace";

// ── Module-level token store (request-scoped, mutated per request) ────────────
// Each request sets this before the MCP handler runs. Cloudflare Workers
// processes one request at a time per isolate, so this is safe.
let _currentAccessToken = "";
const getCreds = async () => ({ accessToken: _currentAccessToken });

// ── McpServer singleton — registered once, reused across warm requests ────────
let _server: McpServer | null = null;
let _searchEnv: Env | null = null;

function getOrCreateServer(env: Env): McpServer {
  if (_server && _searchEnv === env) return _server;

  const server = new McpServer({ name: "mcp-google-workspace", version: "2.1.0" });

  // ── Core tools ───────────────────────────────────────────────────────────────
  registerGmailTools(server, getCreds);          // 11 tools
  registerGmailExtraTools(server, getCreds);     // +3 tools (threads batch, filters)
  registerCalendarTools(server, getCreds);       // 8 tools
  registerDriveTools(server, getCreds);          // 15 tools
  registerDriveExtraTools(server, getCreds);     // +2 tools (download URL, public access)
  registerDocsTools(server, getCreds);           // 13 tools
  registerDocsExtraTools(server, getCreds);      // +8 tools (search, tabs, table, headers)
  registerSheetsTools(server, getCreds);         // 8 tools
  registerSheetsExtraTools(server, getCreds);    // +1 tool (conditional formatting)
  registerSlidesTools(server, getCreds);         // 5 tools
  registerSlidesExtendedTools(server, getCreds); // +18 Slides tools
  registerChatTools(server, getCreds);           // 4 tools
  registerTasksTools(server, getCreds);          // 9 tools
  registerFormsTools(server, getCreds);          // 5 tools
  registerContactsTools(server, getCreds);       // 11 tools
  registerContactsExtraTools(server, getCreds);  // +1 tool (batch)
  registerAppsScriptTools(server, getCreds);     // 11 tools
  registerAppsScriptExtraTools(server, getCreds);// +5 tools (versions, delete, metrics)
  registerSearchTools(server, getCreds, env);    // 3 tools
  registerWorkspaceExtraTools(server, getCreds); // +6 tools
  registerDocsAdvancedTools(server, getCreds);   // +10 tools (Phase 5: named ranges, footnotes, images, styling, suggestions)
  registerDriveRevisionsTools(server, getCreds); // +6 tools (Phase 6: Drive version control)
  // ──────────────────────────────────────────── Total: ~164 tools ──

  _server = server;
  _searchEnv = env;
  return server;
}

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
      env.OAUTH_KV,
      env.GOOGLE_OAUTH_CLIENT_ID,    // fallback cho tokens cũ (trước khi multi-tenant upgrade)
      env.GOOGLE_OAUTH_CLIENT_SECRET,
    );
  } catch (err) {
    console.error("[mcp-agent] getValidAccessToken failed:", err);
    return unauthorizedResponse(env.PUBLIC_BASE_URL);
  }

  // Inject access token into the module-level closure for this request
  _currentAccessToken = accessToken;

  const server = getOrCreateServer(env);

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
