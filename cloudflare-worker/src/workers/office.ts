/**
 * Office Worker — Entry Point
 * Serves: Docs, Sheets, Slides, Drive, Forms, AppsScript (~90 tools)
 * Auth: delegated to google-auth.tuongbeo.workers.dev
 *
 * Base routes:  /mcp, /authorize, /callback-delegate, /health
 * Tenant routes: /:tenant/mcp, /:tenant/authorize, /:tenant/callback-delegate
 */
import { createWorker, withTenantRouting } from "./shared";
import { OfficeAgent } from "./agents/office-agent";

const config = {
  service:    "mcp-office",
  agent:      OfficeAgent,
  serverName: "office",
  namespace:  "office",
};

export default withTenantRouting(createWorker(config), config);

export { OfficeAgent };
