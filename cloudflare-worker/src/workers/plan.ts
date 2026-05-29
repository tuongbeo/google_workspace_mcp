/**
 * Plan Worker — Entry Point
 * Serves: Gmail, Calendar, Tasks, Search (~33 tools)
 * Auth: delegated to google-auth.tuongbeo.workers.dev
 */
import { createWorker } from "./shared";
import { PlanAgent } from "./agents/plan-agent";

export default createWorker({
  service:    "mcp-plan",
  agent:      PlanAgent,
  serverName: "plan",
  namespace:  "plan",
});

export { PlanAgent };
