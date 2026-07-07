import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withSmartDefaults } from "../utils/tool-annotations";

describe("withSmartDefaults", () => {
  it("fills in all hints and a title when a tool registers with no annotations object", () => {
    const server = withSmartDefaults(new McpServer({ name: "t", version: "1.0.0" }));
    const registered = server.tool("send_gmail_message", "desc", { to: z.string() }, async () => ({ content: [] }));
    expect(registered.annotations).toEqual({
      title: "Send Gmail Message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("fills in missing hints but keeps explicitly-set ones untouched", () => {
    const server = withSmartDefaults(new McpServer({ name: "t", version: "1.0.0" }));
    const registered = server.tool(
      "delete_contact", "desc", { resource_name: z.string() },
      { readOnlyHint: false, destructiveHint: true },
      async () => ({ content: [] }),
    );
    expect(registered.annotations).toEqual({
      title: "Delete Contact",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("does not override an explicit title", () => {
    const server = withSmartDefaults(new McpServer({ name: "t", version: "1.0.0" }));
    const registered = server.tool(
      "get_contact", "desc", {},
      { title: "Custom Title", readOnlyHint: true },
      async () => ({ content: [] }),
    );
    expect(registered.annotations?.title).toBe("Custom Title");
    expect(registered.annotations?.readOnlyHint).toBe(true);
  });
});
