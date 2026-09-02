// Thin wrapper over the Twilio Voice SDK. One Device per page, reused across
// calls; the token is refreshed from the server whenever a call starts.

import { Call, Device } from "@twilio/voice-sdk";

export type VoiceEvents = {
  onRinging?: () => void;
  onAccept?: () => void;
  onDisconnect?: () => void;
  onError?: (message: string) => void;
};

export class VoiceClient {
  private device: Device | null = null;
  private call: Call | null = null;
  /** Device-level failures (bad token, signaling down) arrive as an event, not
   *  as the connect() rejection, which can carry no value at all. Keep the
   *  last one so a rejected connect can still explain itself. */
  private lastDeviceError: { message?: string; code?: number } | null = null;

  static get supported(): boolean {
    return Device.isSupported;
  }

  ensure(token: string): Device {
    if (this.device) {
      this.device.updateToken(token);
      return this.device;
    }
    this.device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      logLevel: "error",
    });
    this.device.on("error", (e: { message?: string; code?: number }) => {
      this.lastDeviceError = e;
    });
    return this.device;
  }

  async connect(token: string, params: Record<string, string>, ev: VoiceEvents): Promise<void> {
    const device = this.ensure(token);
    this.lastDeviceError = null;
    let call: Call;
    try {
      // Device.connect asks for the microphone; a denied permission surfaces as an error.
      call = await device.connect({ params });
    } catch (e) {
      const err = (e as { message?: string; code?: number } | undefined) || this.lastDeviceError;
      throw new Error(friendly(err || {}));
    }
    this.call = call;
    call.on("ringing", () => ev.onRinging?.());
    call.on("accept", () => ev.onAccept?.());
    call.on("disconnect", () => {
      this.call = null;
      ev.onDisconnect?.();
    });
    call.on("cancel", () => {
      this.call = null;
      ev.onDisconnect?.();
    });
    call.on("error", (e: { message?: string; code?: number }) => {
      ev.onError?.(friendly(e));
    });
  }

  hangup(): void {
    this.call?.disconnect();
    this.call = null;
  }

  get active(): boolean {
    return this.call !== null;
  }

  destroy(): void {
    this.call?.disconnect();
    this.call = null;
    this.device?.destroy();
    this.device = null;
  }
}

function friendly(e: { message?: string; code?: number }): string {
  switch (e.code) {
    case 31208:
      return "Microphone access was denied. Allow the microphone for this site and try again.";
    case 31402:
    case 31401:
      return "No microphone found or it could not be opened.";
    case 20101:
    case 20104:
      return "The Twilio token was rejected. Check the API key and TwiML App settings.";
    case 31005:
      return "Lost the connection to Twilio.";
    default:
      return e.message ? `Twilio: ${e.message}` : "The call failed.";
  }
}
