/**
 * Office Worker — Entry Point
 * Serves: Docs, Sheets, Slides, Drive, Forms, AppsScript (~90 tools)
 */
import { createWorker } from "./shared";
import { OfficeAgent } from "./agents/office-agent";
import { SCOPES_OFFICE } from "../auth/scopes";

export default createWorker({
  service:   "mcp-office",
  agent:     OfficeAgent,
  scopes:    SCOPES_OFFICE,
  namespace: "office",
});

export { OfficeAgent };
