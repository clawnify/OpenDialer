# Twilio setup for OpenDialer

Everything below happens in the [Twilio Console](https://console.twilio.com).
Budget 15 minutes. You need a Twilio account with a payment method for
anything beyond calling your own verified numbers.

## 1. Account credentials

Console home → **Account Info**.

- Copy **Account SID** → `TWILIO_ACCOUNT_SID`
- Copy **Auth Token** → `TWILIO_AUTH_TOKEN`

## 2. Buy a voice-capable number

**Phone Numbers → Manage → Buy a number.** Tick **Voice**. Buy:

- one **US** number (required)
- one number per European country you call, for local presence (optional;
  most EU countries require address and identity documents, which Twilio
  collects under **Regulatory Compliance** before the purchase completes)

Open **/numbers** in the app and click **Sync from Twilio**: every voice
number you own becomes a selectable caller ID, and the first one is the
default when no number matches the lead's country. To pin a specific default,
set `TWILIO_FROM_NUMBER` (E.164, `+14155550100`).

## 3. API key (for browser calling)

**Account → API keys & tokens → Create API key.** Type *Standard*.

- **SID** → `TWILIO_API_KEY_SID`
- **Secret** → `TWILIO_API_KEY_SECRET` (shown once)

## 4. TwiML App (for browser calling)

**Voice → Manage → TwiML apps → Create new TwiML App.**

- Friendly name: `OpenDialer`
- **Voice Configuration → Request URL**: `https://<your-app-host>/api/twilio/voice`, method **POST**
- Leave Messaging empty. Save.
- Copy the **SID** (starts with `AP`) → `TWILIO_TWIML_APP_SID`

The app's **/settings** page prints the exact request URL for your deployment.
Status and recording callbacks are set by the app on every call, so nothing
else needs configuring in the console.

## 5. Geographic permissions

**Voice → Settings → Geo permissions.** Enable every country you will call.
Twilio blocks most non-US destinations by default; the app surfaces this as
"Calling this destination is disabled on your Twilio account".

## 6. Environment variables

Set these in Clawnify under **Settings → Environment Variables** (or in
`.dev.vars` locally), then deploy:

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=+14155550100   # optional
TWILIO_TWIML_APP_SID=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=
```

If the Twilio Account SID and Auth Token are already saved under
**Settings → API Keys → Twilio**, they are injected automatically and only the
remaining four need to be added as environment variables.

Without the last three the app still works in **fallback mode**: it calls the
phone number you save under **/settings**, then bridges you to the lead.

## 7. Trial accounts: upgrade first

The current Twilio trial program strips `<Dial><Number>` and the recording
attributes from TwiML and replaces them with a spoken "not available on trial
accounts" message. That is exactly the TwiML this app returns, so on a trial
account the browser connects, hears that message, and no lead is ever dialed.
The fallback mode bridges the same way and is blocked too.

Upgrade the account (add a payment method) before testing. The only thing a
trial can exercise is number sync on **/numbers**.

## 8. Check it

1. Open **/settings**: both badges should be green.
2. Open **/numbers** → **Sync from Twilio**: your numbers appear.
3. Add yourself as a lead, open **/dialer?lead=…**, click **Call**, allow the
   microphone, and answer your phone.
