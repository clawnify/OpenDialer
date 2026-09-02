import { describe, expect, it } from "vitest";
import { dialTwiml, expectedSignature, voiceAccessToken } from "./twilio.js";

describe("expectedSignature", () => {
  // Worked example from Twilio's "validating requests" docs.
  it("matches Twilio's documented example", async () => {
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    expect(await expectedSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
});

describe("voiceAccessToken", () => {
  it("emits a three-part HS256 JWT with the Twilio content type and a voice grant", async () => {
    const token = await voiceAccessToken(
      { DB: {} as D1Database, TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_API_KEY_SID: "SKxxx", TWILIO_API_KEY_SECRET: "secret", TWILIO_TWIML_APP_SID: "APxxx" },
      "rep-1",
    );
    const [h, p, s] = token.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    expect(dec(h)).toEqual({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
    const payload = dec(p);
    expect(payload.iss).toBe("SKxxx");
    expect(payload.sub).toBe("ACxxx");
    expect(payload.grants).toEqual({ identity: "rep-1", voice: { outgoing: { application_sid: "APxxx" } } });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(s.length).toBeGreaterThan(20);
  });
});

describe("voiceAccessToken region", () => {
  it("adds the twr header only outside us1", async () => {
    const env = { DB: {} as D1Database, TWILIO_ACCOUNT_SID: "ACxxx", TWILIO_API_KEY_SID: "SKxxx", TWILIO_API_KEY_SECRET: "s", TWILIO_TWIML_APP_SID: "APxxx" };
    const dec = (t: string) => JSON.parse(Buffer.from(t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    expect(dec(await voiceAccessToken(env, "r")).twr).toBeUndefined();
    expect(dec(await voiceAccessToken({ ...env, TWILIO_REGION: "ie1" }, "r")).twr).toBe("ie1");
  });
});

describe("dialTwiml", () => {
  it("escapes attributes and wires callbacks", () => {
    const xml = dialTwiml({ to: "+442071234567", callerId: "+12125550100", actionUrl: "https://x/a?c=1&l=2", numberStatusUrl: "https://x/s", recordingUrl: "https://x/r", record: true });
    expect(xml).toContain('callerId="+12125550100"');
    expect(xml).toContain('action="https://x/a?c=1&amp;l=2"');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain("<Number statusCallback=");
    expect(xml).toContain(">+442071234567</Number>");
  });
});
