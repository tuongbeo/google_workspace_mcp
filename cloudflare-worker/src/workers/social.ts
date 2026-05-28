/**
 * Social Worker — Entry Point
 * Serves: Google Chat, Contacts (~14 tools)
 */
import { createWorker } from "./shared";
import { SocialAgent } from "./agents/social-agent";
import { SCOPES_SOCIAL } from "../auth/scopes";

export default createWorker({
  service:   "mcp-social",
  agent:     SocialAgent,
  scopes:    SCOPES_SOCIAL,
  namespace: "social",
});

export { SocialAgent };
