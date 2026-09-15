-- Fictional demo records. No Twilio account, caller ID or recording is connected.
INSERT INTO leads (id, first_name, last_name, company, phone, country, timezone, status, notes) VALUES
  ('lead-alex', 'Alex', 'Morgan', 'Northline Studio', '+12125550101', 'US', 'America/New_York', 'called', 'Sample lead: interested in a simpler client onboarding process.'),
  ('lead-jamie', 'Jamie', 'Chen', 'Harbour Property', '+12125550102', 'US', 'America/New_York', 'new', 'Sample lead: explore how the property team tracks enquiries.'),
  ('lead-sam', 'Sam', 'Taylor', 'Cedar & Co', '+12125550103', 'US', 'America/New_York', 'new', 'Sample lead: ask about their weekly client reporting.');
INSERT INTO campaigns (id, name) VALUES ('campaign-followups', 'Client workspace follow-ups');
INSERT INTO campaign_leads (campaign_id, lead_id, position, completed) VALUES
  ('campaign-followups', 'lead-alex', 0, 1),
  ('campaign-followups', 'lead-jamie', 1, 0),
  ('campaign-followups', 'lead-sam', 2, 0);
INSERT INTO calls (id, lead_id, from_number, to_number, status, started_at, ended_at, duration_seconds, record, outcome, notes) VALUES
  ('call-alex', 'lead-alex', '+12125550100', '+12125550101', 'completed', datetime('now', '-1 day', '-4 minutes'), datetime('now', '-1 day'), 240, 0, 'callback', 'Fictional example: send a workspace walkthrough before the next conversation.');
