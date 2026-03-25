/**
 * Utility: withErrorHandler — uniform error handling for all MCP tool handlers.
 *
 * Wraps any tool handler so that unexpected errors are caught and returned as
 * structured text content instead of crashing the MCP transport.
 *
 * Usage:
 *   server.tool("name", "desc", schema, withErrorHandler(async (params) => {
 *     // any throws here are caught automatically
 *     return { content: [{ type: "text", text: result }] };
 *   }));
 */

export type ToolResult = { content: { type: "text"; text: string }[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withErrorHandler<T = any>(
  fn: (params: T) => Promise<ToolResult>
): (params: T) => Promise<ToolResult> {
  return async (params: T): Promise<ToolResult> => {
    try {
      return await fn(params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  };
}

/** Shorthand helper to create a single-text ToolResult. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
