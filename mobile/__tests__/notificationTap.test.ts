/**
 * Tapping a push must land on the screen the push is ABOUT.
 *
 * Nothing listened for the tap, so iOS just foregrounded the app on whatever was last on screen --
 * after a phone call that is Recents, whatever the notification said.
 */
import { routeForNotification, createTapHandler } from "../src/lib/notificationRoute";

const THREAD = (number: string) => ({ pathname: "/thread/[number]", params: { number } });

describe("routeForNotification", () => {
  it("opens the conversation for a text, and for a failed send", () => {
    expect(routeForNotification({ type: "sms", from: "+61412345678" })).toEqual(THREAD("+61412345678"));
    expect(routeForNotification({ type: "message_failed", from: "+61412345678" })).toEqual(THREAD("+61412345678"));
  });

  it("keeps a Messenger id or alphanumeric sender exactly as the server sent it", () => {
    expect(routeForNotification({ type: "sms", from: "Service NSW" })).toEqual(THREAD("Service NSW"));
  });

  it("does not treat a sender called 'new' as the compose screen", () => {
    expect(routeForNotification({ type: "sms", from: "new" })).toEqual({ pathname: "/(tabs)/messages" });
  });

  it("falls back to the Messages tab when a text carries no sender", () => {
    expect(routeForNotification({ type: "sms" })).toEqual({ pathname: "/(tabs)/messages" });
    expect(routeForNotification({ type: "sms", from: "" })).toEqual({ pathname: "/(tabs)/messages" });
  });

  it("sends a missed call to Recents, and voicemail and callbacks to the Inbox", () => {
    expect(routeForNotification({ type: "missed_call", from: "+61412345678" })).toEqual({ pathname: "/(tabs)/recents" });
    expect(routeForNotification({ type: "voicemail", from: "+61412345678" })).toEqual({ pathname: "/(tabs)/voicemail" });
    expect(routeForNotification({ type: "callback_request", from: "+61412345678" })).toEqual({ pathname: "/(tabs)/voicemail" });
  });

  it("never navigates on a type it does not know, or on junk", () => {
    expect(routeForNotification({ type: "something_new" })).toBeNull();
    expect(routeForNotification({ type: "incoming_call", from: "+61412345678" })).toBeNull();
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification(null)).toBeNull();
    expect(routeForNotification("sms")).toBeNull();
    expect(routeForNotification({ type: 7 })).toBeNull();
  });
});

describe("createTapHandler", () => {
  const response = (id: string, data: unknown, date = 1) => ({ notification: { date, request: { identifier: id, content: { data } } } });
  const SMS = { type: "sms", from: "+61412345678" };

  function setup(over: { authed?: boolean; blocked?: boolean; openThrows?: number } = {}) {
    let throws = over.openThrows ?? 0;
    const open = jest.fn(() => {
      if (throws-- > 0) throw new Error("Attempted to navigate before mounting the Root Layout");
    });
    const state = { authed: over.authed ?? true, blocked: over.blocked ?? false };
    const handle = createTapHandler({ open, isAuthed: () => state.authed, isBlocked: () => state.blocked });
    return { open, state, handle };
  }

  it("opens the screen for a tap", () => {
    const { open, handle } = setup();
    expect(handle(response("a", SMS))).toBe("opened");
    expect(open).toHaveBeenCalledWith(THREAD("+61412345678"));
  });

  it("handles one tap once, however often the hook re-delivers it", () => {
    const { open, handle } = setup();
    handle(response("a", SMS));
    expect(handle(response("a", SMS))).toBe("ignored");
    expect(open).toHaveBeenCalledTimes(1);
    handle(response("b", SMS));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("treats a later push that reuses an identifier as a new tap", () => {
    const { open, handle } = setup();
    handle(response("a", SMS, 1));
    handle(response("a", SMS, 2));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps a tap that lands before sign-in is restored, and opens it once authed", () => {
    const { open, state, handle } = setup({ authed: false });
    expect(handle(response("a", SMS))).toBe("waiting");
    expect(open).not.toHaveBeenCalled();
    state.authed = true;
    expect(handle(response("a", SMS))).toBe("opened");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps a tap whose navigation threw (navigator not mounted yet), and opens it on retry", () => {
    const { open, handle } = setup({ openThrows: 1 });
    expect(handle(response("a", SMS))).toBe("retry");
    expect(handle(response("a", SMS))).toBe("opened");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("drops a tap while a call screen is up, rather than replaying it after the call", () => {
    const { open, state, handle } = setup({ blocked: true });
    expect(handle(response("a", SMS))).toBe("ignored");
    state.blocked = false;
    expect(handle(response("a", SMS))).toBe("ignored");
    expect(open).not.toHaveBeenCalled();
  });

  it("marks a tap with no destination as handled", () => {
    const { open, handle } = setup();
    expect(handle(response("a", { type: "incoming_call" }))).toBe("ignored");
    expect(open).not.toHaveBeenCalled();
  });

  it("never throws on a malformed response", () => {
    const { handle } = setup();
    expect(() => handle(null)).not.toThrow();
    expect(() => handle({})).not.toThrow();
    expect(() => handle({ notification: null })).not.toThrow();
  });
});
