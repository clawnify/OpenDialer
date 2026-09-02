-- Demo data for screenshots and local development. Re-runnable.
DELETE FROM calls WHERE lead_id LIKE '0000000%';
DELETE FROM leads WHERE id LIKE '0000000%';

INSERT INTO leads (id, first_name, last_name, company, phone, country, status, notes) VALUES
  ('00000001-0000-4000-8000-000000000001', 'Ada', 'Lovelace', 'Analytical Engines Ltd', '+442079460958', 'GB', 'new', 'Asked for a demo of the new engine'),
  ('00000001-0000-4000-8000-000000000002', 'Grace', 'Hopper', 'Compiler Works', '+12125550142', 'US', 'called', 'Prefers mornings'),
  ('00000001-0000-4000-8000-000000000003', 'Linus', 'Torvalds', 'Kernel GmbH', '+4930901820', 'DE', 'new', 'Callback after 3pm CET'),
  ('00000001-0000-4000-8000-000000000004', 'Margaret', 'Hamilton', 'Apollo Software', '+16175550189', 'US', 'called', ''),
  ('00000001-0000-4000-8000-000000000005', 'Tim', 'Berners-Lee', 'Web Foundation', '+442079460123', 'GB', 'new', 'Gatekeeper is Sam');

INSERT INTO calls (id, lead_id, user_id, from_number, to_number, twilio_call_sid, mode, status, started_at, ended_at, duration_seconds, outcome, notes, created_at) VALUES
  ('00000002-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000002', 'local', '+12125550100', '+12125550142', 'CA00000000000000000000000000000001', 'browser', 'completed', datetime('now', '-1 day'), datetime('now', '-1 day', '+4 minutes'), 241, 'connected', 'Wants a follow-up next week', datetime('now', '-1 day')),
  ('00000002-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000004', 'local', '+12125550100', '+16175550189', 'CA00000000000000000000000000000002', 'browser', 'no-answer', NULL, datetime('now', '-2 hours'), 0, 'voicemail', '', datetime('now', '-2 hours'));
