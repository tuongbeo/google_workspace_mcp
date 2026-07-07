/**
 * withSmartDefaults — fills in MCP ToolAnnotations that individual tool
 * registrations omit.
 *
 * Per the MCP spec, an omitted `destructiveHint` defaults to `true` (for any
 * non-read-only tool) and `idempotentHint`/`openWorldHint` are left for the
 * client to guess at. Most of this codebase's tools only set `readOnlyHint`,
 * so every write tool that doesn't also set `destructiveHint: false` is
 * silently flagged as destructive to MCP clients — which can make clients
 * over-prompt for confirmation on ordinary, non-destructive writes (e.g.
 * adding a comment, creating a draft). This wraps `McpServer.tool()` once at
 * construction time so every registration gets sane defaults without having
 * to touch each of the ~190 individual `server.tool(...)` call sites.
 *
 * Explicit fields on a given tool always win — this only fills in gaps.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function toTitleCase(name: string): string {
  return name.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function smartDefaults(name: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: toTitleCase(name),
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    ...existing,
  };
}

export function withSmartDefaults(server: McpServer): McpServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig = (server as any).tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (name: string, description: string, schema: unknown, ...rest: any[]) => {
    if (rest.length >= 2 && typeof rest[0] === "object" && rest[0] !== null) {
      const [annotations, ...more] = rest;
      return orig(name, description, schema, smartDefaults(name, annotations), ...more);
    }
    // rest === [handler] — no annotations object was passed at all
    return orig(name, description, schema, smartDefaults(name), ...rest);
  };
  return server;
}
