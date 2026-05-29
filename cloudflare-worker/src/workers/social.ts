/**
 * Social Worker — Entry Point
 * Serves: Google Chat, Contacts (~14 tools)
 * Auth: delegated to google-auth.tuongbeo.workers.dev
 */
import { createWorker } from "./shared";
import { SocialAgent } from "./agents/social-agent";

export default createWorker({
  service:    "mcp-social",
  agent:      SocialAgent,
  serverName: "social",
  namespace:  "social",
});

export { SocialAgent };
