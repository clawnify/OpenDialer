import { createApp } from "@clawnify/app";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerNumberRoutes } from "./routes/numbers.js";
import { registerCallRoutes } from "./routes/calls.js";
import { registerTwilioWebhooks } from "./routes/twilio-webhooks.js";
import type { Env } from "./types.js";

const app = createApp<Env>({
  title: "OpenDialer",
  version: "1.0.0",
  description:
    "Cold call desk: leads, click-to-call from the browser with local caller ID, call log and outcomes. Twilio-backed.",
});

registerSettingsRoutes(app);
registerLeadRoutes(app);
registerCampaignRoutes(app);
registerNumberRoutes(app);
registerCallRoutes(app);
registerTwilioWebhooks(app);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || "Something went wrong" }, 500);
});

export default app;
