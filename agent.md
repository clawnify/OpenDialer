# OpenDialer — agent guide

## What you do, and what you must not

**The rep talks. You prepare and log.** Every live conversation has a human on
the line; the app enforces one call at a time per rep and never dials without a
click.

- **You** import and clean lead lists, build campaigns, summarise call history,
  and keep notes tidy.
- **The app** places calls (browser or phone bridge), tracks status, stores
  recordings, and records outcomes.

**Never place a call on the rep's behalf.** `POST /api/calls` opens a live
line to a real person; only the dialer screen should trigger it. Do not loop
over leads calling `POST /api/calls`.

**Never invent or scrape phone numbers.** Only numbers the user gives you go
into `leads`. Only numbers the Twilio account owns can be caller IDs.

## Applying the deploy answers

The deploy form asks for `company_name` and `primary_market` (US, Europe, Both).

- `company_name`: put it in the `<title>` in `index.html` and the sidebar brand
  label in `src/client/app.tsx`. Nothing else is branded.
- `primary_market`: only affects `default_country` hints. For "Europe" pre-fill
  the CSV import's default country with the user's own country when they tell
  you it; do not narrow `SUPPORTED_COUNTRIES`.
- Caller IDs are not a deploy answer: after the user syncs their Twilio numbers
  on `/numbers`, local presence picks one per lead and the first synced number
  is the default. `TWILIO_FROM_NUMBER` is an optional pin.

## Procedure: get a list ready to call

1. Normalise the list. Every phone must be E.164 (`+15551234567`) or national
   format with a `country` column (US, CA, GB, IE, DE, FR, ES, IT, NL, BE, AT,
   CH, SE, NO, DK, FI, PL, PT). Anything else is rejected on import.
2. `POST /api/leads/import` with `{ "csv": "first_name,last_name,company,phone,country,notes\n..." }`.
   Read `rejected` and `errors[]` back to the user; do not silently drop rows.
3. Duplicates by phone are skipped (`duplicates` in the response).
4. `POST /api/campaigns` with `{ "name": "...", "filter": { "status": "new" } }`
   or explicit `lead_ids`. Tell the user to open `/dialer?campaign=<id>`.
5. If `/api/settings` says `configured: false`, stop and tell the user which
   env vars are missing. If `voice_sdk_enabled: false`, tell them calls will
   ring their own phone first and they need a callback number in Settings.

## Procedure: report on calling

- `GET /api/calls?limit=25` for the latest attempts; `GET /api/leads/{id}` for
  one lead's full history with outcomes, durations and recording links.
- Outcomes: connected, voicemail, no_answer, busy, wrong_number,
  not_interested, callback, do_not_call. `do_not_call` also flags the lead.
- A `callback` outcome is a promise: surface those leads first
  (`GET /api/leads?status=called` and filter `last_outcome == "callback"`).

## Pages

- `/` dashboard: leads to call, callbacks due, last 20 calls.
- `/leads` full-bleed table with search, add, and CSV import. **Screenshot-friendly.**
- `/leads/:id` lead detail with call history and recordings.
- `/dialer?campaign=<id>` or `/dialer?lead=<id>` the working screen.
- `/numbers` owned caller IDs; `/settings` provider status and webhook URLs.

## API anchors

Full schemas: `GET /llms.txt` and `GET /api/openapi.json`. Lists are paginated
(`?page=`, `?limit=` max 100).

- `POST /api/leads` `{ "phone": "+442071234567", "first_name": "...", "company": "..." }`
- `POST /api/leads/import` `{ "csv": "...", "default_country": "GB" }`
- `POST /api/campaigns` `{ "name": "...", "filter": { "status": "new", "country": "US" } }`
- `POST /api/numbers/sync` after the user buys a number in Twilio.
- `POST /api/calls/{id}/outcome` `{ "outcome": "callback", "notes": "..." }` when the user asks you to log a result they told you about.

## Failures and cost

- `400` with an `error` string is a validation message meant for the user
  (bad phone, unsupported country, missing configuration). Relay it verbatim.
- `409` on `POST /api/calls`: the rep already has a live call.
- `502` prefixed `Twilio:` is the carrier's own message. Trial accounts can only
  call verified numbers.
- Every call and every recording costs Twilio money. Syncing numbers and
  reading logs is free.
