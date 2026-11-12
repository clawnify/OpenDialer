import { createApp } from "@clawnify/app";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerNumberRoutes } from "./routes/numbers.js";
import { registerCallRoutes } from "./routes/calls.js";
import { registerTwilioWebhooks } from "./routes/twilio-webhooks.js";
import { registerInboundWebhooks } from "./routes/inbound-webhooks.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import type { Env } from "./types.js";

const app = createApp<Env>({
  title: "OpenDialer",
  version: "2.0.0",
  description:
    "Phone system for sales and support teams: inbound numbers with business hours, a press-a-digit menu and ring groups, browser calling with local caller ID, warm and blind transfers, voicemail, and a shared inbox for missed calls. Twilio-backed.",
});

registerSettingsRoutes(app);
registerLeadRoutes(app);
registerCampaignRoutes(app);
registerNumberRoutes(app);
// Before registerCallRoutes: /api/calls/ringing must win over /api/calls/{id}.
registerInboxRoutes(app);
registerCallRoutes(app);
registerTeamRoutes(app);
registerTwilioWebhooks(app);
// After registerTwilioWebhooks: its signature middleware must run first.
registerInboundWebhooks(app);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || "Something went wrong" }, 500);
});

export default app;
