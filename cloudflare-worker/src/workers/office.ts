/**
 * Office Worker — Entry Point
 * Serves: Docs, Sheets, Slides, Drive, Forms, AppsScript (~90 tools)
 * Auth: delegated to google-auth.tuongbeo.workers.dev
 */
import { createWorker } from "./shared";
import { OfficeAgent } from "./agents/office-agent";

export default createWorker({
  service:    "mcp-office",
  agent:      OfficeAgent,
  serverName: "office",
  namespace:  "office",
});

export { OfficeAgent };
