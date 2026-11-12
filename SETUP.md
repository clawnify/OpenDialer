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

## 3. API key (for browser calling, inbound and outbound)

**Account → API keys & tokens → Create API key.** Type *Standard*. Reps'
browsers ring for inbound calls with a token signed by this key, so taking calls
needs it even when you never call out.

- **SID** → `TWILIO_API_KEY_SID`
- **Secret** → `TWILIO_API_KEY_SECRET` (shown once)

## 4. TwiML App (for outbound browser calls)

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

## 8. Ireland region (optional)

For EU data residency set `TWILIO_REGION=ie1` and redo steps 1, 3 and 4 inside the Ireland region of the console. The region is part of the URL, and the page badge reads "Ireland (IE1) Region":

- IE1 Auth Token and API key: `https://console.twilio.com/ie1/account/keys-credentials/api-keys` (the Auth Tokens section on that page is the IE1 token, distinct from the US1 one).
- IE1 TwiML App: `https://console.twilio.com/ie1/develop/voice/manage/twiml-apps`, same voice URL as step 4.

Then set each number's voice region to Ireland (Phone Numbers → the number → Voice configuration). Mixing a US1 key with `ie1`, or the US1 Auth Token with the IE1 API host, fails with "The Twilio token was rejected" or a 401 from Twilio.

After changing any of these in Clawnify, redeploy: the values are injected at deploy time, and the first request or two after a deploy can still be answered by the previous version.

## 9. Taking calls

Nothing to configure in the console: the app sets the number's voice URL.

Steps 1 and 2 take a workspace admin.

1. **/teams**: create a team and tick its members. Teammates appear there once
   they have opened the app.
2. **/numbers**: open a number, choose one team or a menu, optionally set
   business hours and greetings, then **Save and take calls here**. This points
   the number's voice URL and status callback at the app and clears any TwiML
   App on it; what it pointed at before (voice URL, TwiML App, status callback)
   is kept, and **Disconnect** puts it back.
   If the number is also used elsewhere (another system answers it today),
   connecting moves its calls here.
3. Each rep sets themselves **Available** (bottom right). Calls ring a rep only
   while they are available, have the app open in a tab, and are not on
   another call. Close the tab and the rep stops ringing within 90 seconds.

Each rep phone rung for a call is a separate Twilio call to that browser, so a
team of five ringing for one inbound call places five calls, plus the answered
rep's minutes in the conference. Check Twilio's Voice pricing for browser
(Client) calls and conferences before ringing large teams.

Twilio places these calls at your account's calls-per-second limit, which is one
per second by default, and queues the rest. With five reps available, the fifth
starts ringing about four seconds after the first; two calls arriving together
queue behind each other. For teams larger than a handful, ask Twilio to raise
your account's limit before going live.

For EU data residency, set the number's voice region to Ireland as in step 8;
the app's inbound webhooks are the same.

## 10. Check it

1. Open **/settings**: both badges should be green.
2. Open **/numbers** → **Sync from Twilio**: your numbers appear.
3. Add yourself as a lead, open **/dialer?lead=…**, click **Call**, allow the
   microphone, and answer your phone.
4. Connect a number (step 9), set yourself Available, and call the number from
   your phone: the call rings in the browser. Decline it and let it ring out:
   your voicemail greeting plays and the message shows up in **/inbox**.
