/// <reference types="jest" />
jest.mock("../src/lib/session");
import * as session from "../src/lib/session";
import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { wireQueryFocusToAppState } from "../src/lib/queryFocus";
import { getThread } from "../src/lib/api";

const flush = () => new Promise((r) => setImmediate(r));

function fakeAppState() {
  let handler: ((s: string) => void) | null = null;
  return {
    addEventListener: (_: "change", fn: (s: string) => void) => {
      handler = fn;
      return { remove: () => { handler = null; } };
    },
    emit: (s: string) => handler?.(s),
  };
}

// React Query's refetch-on-focus listens for the browser's `visibilitychange`, which does not exist
// on React Native -- so an open thread and Recents never refreshed on their own, however long the
// phone sat in a pocket. Coming back to the app has to count as focus.
describe("wireQueryFocusToAppState", () => {
  afterEach(() => focusManager.setEventListener(() => undefined));

  it("refetches stale queries when the app returns to the foreground", async () => {
    const appState = fakeAppState();
    wireQueryFocusToAppState(appState);
    const client = new QueryClient();
    client.mount();
    const queryFn = jest.fn().mockResolvedValue(["row"]);
    const unsub = new QueryObserver(client, { queryKey: ["calls"], queryFn }).subscribe(() => {});
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);

    appState.emit("background");
    appState.emit("active");
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(2);

    unsub();
    client.unmount();
    client.clear(); // drops the cache's gc timers, which otherwise hold Jest open for minutes
  });
});

// The open thread now polls, so a single failed poll must not replace the conversation on screen
// with "No Messages Yet". Swallowing the error into [] did exactly that; a rejection keeps the data.
describe("getThread", () => {
  beforeEach(() => { (session.getToken as jest.Mock).mockResolvedValue(null); });

  it("fails loudly so a failed refresh keeps the messages already shown", async () => {
    const msgs = [{ id: "m1" }];
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(msgs) })
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["thread", "0412345678"];
    const queryFn = () => getThread("0412345678");

    await client.fetchQuery({ queryKey: key, queryFn });
    await client.fetchQuery({ queryKey: key, queryFn }).catch(() => {});

    expect((global as any).fetch).toHaveBeenCalledTimes(2);

    expect(client.getQueryData(key)).toEqual(msgs);
    client.clear();
  });
});
