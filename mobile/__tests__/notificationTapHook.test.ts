/**
 * The CALL SITE of tap routing: what the hook does with a real response. `@testing-library` cannot
 * run here, so React's hooks are stubbed to run inline and the hook is called as a plain function.
 */
const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockState: { last: unknown; path: string; call: boolean; effects: Array<() => void | (() => void)> } = {
  last: null, path: "/recents", call: false, effects: [],
};

jest.mock("react", () => ({ useEffect: (fn: () => void | (() => void)) => { mockState.effects.push(fn); } }));
jest.mock("expo-notifications", () => ({ useLastNotificationResponse: () => mockState.last }));
jest.mock("expo-router", () => ({
  router: { push: (r: unknown) => mockPush(r), navigate: (r: unknown) => mockNavigate(r) },
  usePathname: () => mockState.path,
}));
jest.mock("../src/lib/voice", () => ({ getActiveCall: () => (mockState.call ? {} : null) }));

const tap = (id: string, data: unknown) => ({ notification: { date: 1, request: { identifier: id, content: { data } } } });

function render(authed = true) {
  mockState.effects = [];
  let hook: (a: boolean) => void = () => {};
  jest.isolateModules(() => { hook = require("../src/lib/useNotificationTaps").useNotificationTaps; });
  return { run: () => { hook(authed); mockState.effects.forEach((e) => e()); } };
}

beforeEach(() => {
  mockPush.mockClear(); mockNavigate.mockClear();
  Object.assign(mockState, { last: null, path: "/recents", call: false });
});

describe("useNotificationTaps", () => {
  it("pushes a thread for a text and switches tab for a missed call", () => {
    mockState.last = tap("a", { type: "sms", from: "+61412345678" });
    render().run();
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/thread/[number]", params: { number: "+61412345678" } });

    mockState.last = tap("b", { type: "missed_call", from: "+61412345678" });
    const { run } = render();
    run();
    expect(mockNavigate).toHaveBeenCalledWith({ pathname: "/(tabs)/recents" });
  });

  it("does nothing when signed out", () => {
    mockState.last = tap("a", { type: "sms", from: "+61412345678" });
    render(false).run();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not stack a second copy of the conversation already on screen", () => {
    mockState.path = "/thread/%2B61412345678";
    mockState.last = tap("a", { type: "sms", from: "+61412345678" });
    render().run();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not navigate over a live call or the ringing screen", () => {
    mockState.last = tap("a", { type: "sms", from: "+61412345678" });
    mockState.call = true;
    render().run();
    mockState.call = false;
    mockState.path = "/call-incoming";
    mockState.last = tap("b", { type: "sms", from: "+61412345678" });
    render().run();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
