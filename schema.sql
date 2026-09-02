-- UUID text primary keys (not incremental) so ids are not enumerable.
-- Ids are generated in the app layer with crypto.randomUUID().
-- Every timestamp is UTC: datetime('now') in SQLite is UTC by definition.

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  -- Always E.164 (+15551234567). Normalised on write; a row never holds a
  -- national-format number.
  phone TEXT NOT NULL,
  -- ISO 3166-1 alpha-2, derived from the phone number (US, GB, DE, ...).
  country TEXT NOT NULL DEFAULT '',
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'new', -- new|calling|called|do_not_call
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

-- Caller IDs. Only numbers the Twilio account actually owns land here (via
-- POST /api/numbers/sync); the app never dials from a number it did not sync.
CREATE TABLE IF NOT EXISTS numbers (
  id TEXT PRIMARY KEY,
  e164 TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT '',
  -- NANP area code ("415") for US/CA; empty elsewhere.
  area_code TEXT NOT NULL DEFAULT '',
  twilio_sid TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id TEXT,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  -- The PSTN leg's SID once Twilio reports it. In browser mode the browser
  -- leg has its own SID (parent_call_sid); status/duration come from the
  -- PSTN leg.
  twilio_call_sid TEXT,
  parent_call_sid TEXT,
  -- browser: Voice SDK in the page. api: Twilio rings the rep's phone first,
  -- then bridges to the lead.
  mode TEXT NOT NULL DEFAULT 'browser',
  direction TEXT NOT NULL DEFAULT 'outbound',
  status TEXT NOT NULL DEFAULT 'initiated', -- initiated|ringing|in-progress|completed|failed|no-answer|busy|canceled
  started_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER,
  -- Snapshot of the rep's preference when the call was placed.
  record INTEGER NOT NULL DEFAULT 1,
  recording_url TEXT,
  recording_sid TEXT,
  recording_duration INTEGER,
  outcome TEXT, -- connected|voicemail|no_answer|busy|wrong_number|not_interested|callback|do_not_call
  notes TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_user_status ON calls(user_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_sid ON calls(twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_calls_parent_sid ON calls(parent_call_sid);

-- A campaign is an ordered list the rep works one lead at a time.
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_order ON campaign_leads(campaign_id, completed, position);

-- Per-rep preferences. The callback number is only used by the API fallback
-- mode (Twilio rings the rep's own phone first).
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  callback_number TEXT NOT NULL DEFAULT '',
  default_from_number TEXT NOT NULL DEFAULT '',
  record_calls INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
