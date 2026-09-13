jest.mock("expo-secure-store");
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { getToken, setToken, clearToken, getTokenWhenReadable } from "../src/lib/session";

const store = SecureStore as jest.Mocked<typeof SecureStore>;

describe("session token store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.getItemAsync.mockResolvedValue(null);
  });

  // A VoIP push launches the app on a LOCKED iPhone. The default (WHEN_UNLOCKED) item cannot be
  // read then, the restore threw, and the app sat on its spinner with no call UI.
  it("setToken stores the token readable after first unlock", async () => {
    await setToken("abc.def");
    expect(store.setItemAsync).toHaveBeenCalledWith("tcb_session_token_v2", "abc.def", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });

  it("getToken reads the current key", async () => {
    store.getItemAsync.mockImplementation(async (k: string) => (k === "tcb_session_token_v2" ? "abc.def" : null));
    expect(await getToken()).toBe("abc.def");
  });

  // Accessibility is fixed when an item is written, and SecureStore's update keeps the old value,
  // so an existing token has to be rewritten under a new key. Written first, old deleted after:
  // a crash in between must not sign anyone out.
  it("moves a token stored the old way to the new key, writing before deleting", async () => {
    store.getItemAsync.mockImplementation(async (k: string) => (k === "tcb_session_token" ? "old.tok" : null));
    const order: string[] = [];
    store.setItemAsync.mockImplementation(async () => { order.push("set"); });
    store.deleteItemAsync.mockImplementation(async () => { order.push("delete"); });

    expect(await getToken()).toBe("old.tok");
    expect(store.setItemAsync).toHaveBeenCalledWith("tcb_session_token_v2", "old.tok", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    expect(store.deleteItemAsync).toHaveBeenCalledWith("tcb_session_token");
    expect(order).toEqual(["set", "delete"]);
  });

  // api.ts and the auth restore both read at launch. Two moves racing let one delete the legacy
  // key between the other's two reads, which returned null, 401'd, and signed the user out.
  it("gives concurrent reads during the move the same token", async () => {
    const keys = new Map<string, string>([["tcb_session_token", "old.tok"]]);
    const tick = () => new Promise((r) => setImmediate(r));
    store.getItemAsync.mockImplementation(async (k: string) => { await tick(); return keys.get(k) ?? null; });
    store.setItemAsync.mockImplementation(async (k: string, v: string) => { await tick(); keys.set(k, v); });
    store.deleteItemAsync.mockImplementation(async (k: string) => { await tick(); keys.delete(k); });

    expect(await Promise.all([getToken(), getToken()])).toEqual(["old.tok", "old.tok"]);
    // One move, not two racing ones -- the interleaving that loses the token is timing-dependent,
    // so what is pinned is that it cannot happen at all.
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it("clearToken deletes both keys", async () => {
    await clearToken();
    expect(store.deleteItemAsync).toHaveBeenCalledWith("tcb_session_token_v2");
    expect(store.deleteItemAsync).toHaveBeenCalledWith("tcb_session_token");
  });
});

describe("getTokenWhenReadable", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
  });

  // Unlocked and opened before the listener attached: no further change event ever comes. Waiting
  // for one left the app on its spinner until it was backgrounded and reopened.
  it("retries at once when the app is already active", async () => {
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    const add = jest.spyOn(AppState, "addEventListener");
    store.getItemAsync
      .mockRejectedValueOnce(new Error("User interaction is not allowed."))
      .mockResolvedValue("abc.def");

    expect(await getTokenWhenReadable()).toBe("abc.def");
    expect(add).not.toHaveBeenCalled();
  });

  // iOS can report active a moment before protected data is readable -- whether the read started
  // locked (unlocked mid-read) or right after a wake. Two review rounds found a way for each
  // "count only some refusals" rule to sign out a valid token. A short run of refusals while active
  // is the unlock settling, whatever order it arrived in.
  it("rides out several refusals while active before reading the token", async () => {
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    store.getItemAsync
      .mockRejectedValueOnce(new Error("User interaction is not allowed."))
      .mockRejectedValueOnce(new Error("User interaction is not allowed."))
      .mockRejectedValueOnce(new Error("User interaction is not allowed."))
      .mockResolvedValue("abc.def");

    expect(await getTokenWhenReadable()).toBe("abc.def");
  }, 10_000);

  // Refusal that persists while active is not the lock (e.g. an Android keystore that cannot
  // decrypt). Waiting for an unlock that is not coming is a spinner forever; signed out at least
  // lets them sign in.
  it("treats refusals that persist while active as signed out", async () => {
    Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
    store.getItemAsync.mockRejectedValue(new Error("decrypt failed"));

    expect(await getTokenWhenReadable()).toBeNull();
    expect(store.getItemAsync.mock.calls.length).toBeGreaterThanOrEqual(5);
  }, 10_000);

  // The keychain refusing a read is not "signed out". Treating it as anon would put a locked-launch
  // user on the login screen; leaving it thrown left them on a spinner. Wait for the app to be
  // active (unlocked) and read again.
  it("retries a refused read once the app becomes active", async () => {
    let listener: ((s: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, fn: (s: string) => void) => {
      listener = fn;
      return { remove };
    }) as never);
    store.getItemAsync
      .mockRejectedValueOnce(new Error("User interaction is not allowed."))
      .mockResolvedValue("abc.def");

    const pending = getTokenWhenReadable();
    await new Promise((r) => setImmediate(r));
    expect(listener).toBeDefined();
    listener!("active");

    expect(await pending).toBe("abc.def");
    expect(remove).toHaveBeenCalled();
  });
});
