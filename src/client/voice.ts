// Thin wrapper over the Twilio Voice SDK. One Device per page, shared by the
// outbound dialer and inbound ringing (PhoneProvider owns the instance). The
// token is refreshed whenever a call starts and before it expires while the
// device is registered for inbound calls.

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

  /** Inbound: register under this rep's identity so calls to client:<identity> ring here. */
  async register(token: string, edge: string | null, onIncoming: (call: Call) => void, refreshToken: () => Promise<string>): Promise<void> {
    const device = this.ensure(token, edge);
    device.removeAllListeners("incoming");
    device.removeAllListeners("tokenWillExpire");
    device.on("incoming", onIncoming);
    device.on("tokenWillExpire", () => {
      refreshToken().then((t) => device.updateToken(t)).catch(() => {});
    });
    if (device.state === Device.State.Registered) return;
    this.lastDeviceError = null;
    try {
      await device.register();
    } catch (e) {
      // Like connect(), the rejection can carry no value; the device error event explains it.
      throw new Error(friendly((e as { message?: string; code?: number } | undefined) || this.lastDeviceError || {}));
    }
  }

  async unregister(): Promise<void> {
    if (this.device?.state === Device.State.Registered) await this.device.unregister();
  }

  /** Pick up a ringing inbound call. */
  accept(call: Call, ev: VoiceEvents): void {
    this.call = call;
    this.watch(call, ev);
    call.on("accept", () => ev.onAccept?.());
    call.accept();
  }

  mute(muted: boolean): void {
    this.call?.mute(muted);
  }

  get muted(): boolean {
    return this.call?.isMuted() ?? false;
  }

  ensure(token: string, edge: string | null): Device {
    if (this.device) {
      this.device.updateToken(token);
      return this.device;
    }
    this.device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      logLevel: "error",
      // A regional deployment (ie1) must enter through its own edge (dublin);
      // us1 leaves the SDK on its default edge.
      ...(edge ? { edge } : {}),
    });
    this.device.on("error", (e: { message?: string; code?: number }) => {
      this.lastDeviceError = e;
    });
    return this.device;
  }

  async connect(token: string, params: Record<string, string>, ev: VoiceEvents, edge: string | null = null): Promise<void> {
    const device = this.ensure(token, edge);
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
    this.watch(call, ev);
  }

  private watch(call: Call, ev: VoiceEvents): void {
    call.on("disconnect", () => {
      this.call = null;
      this.releaseMic();
      ev.onDisconnect?.();
    });
    call.on("cancel", () => {
      this.call = null;
      this.releaseMic();
      ev.onDisconnect?.();
    });
    call.on("error", (e: { message?: string; code?: number }) => {
      ev.onError?.(friendly(e));
    });
  }

  hangup(): void {
    this.call?.disconnect();
    this.call = null;
    this.releaseMic();
  }

  /**
   * The SDK keeps the input stream open between calls, which leaves the
   * browser's red recording indicator lit after hang-up. Releasing it here
   * turns the indicator off; the next call re-acquires the default mic.
   */
  private releaseMic(): void {
    this.device?.audio?.unsetInputDevice().catch(() => {});
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
