/**
 * Plan Worker — Entry Point
 * Serves: Gmail, Calendar, Tasks, Search (~33 tools)
 */
import { createWorker } from "./shared";
import { PlanAgent } from "./agents/plan-agent";
import { SCOPES_PLAN } from "../auth/scopes";

export default createWorker({
  service:   "mcp-plan",
  agent:     PlanAgent,
  scopes:    SCOPES_PLAN,
  namespace: "plan",
});

export { PlanAgent };
