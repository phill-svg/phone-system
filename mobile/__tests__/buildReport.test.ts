// The handset has to TELL the server which binary it is running, and the bug that made this
// necessary was at the CALL SITE, not in buildLabel: the Settings screen read
// `Constants.nativeBuildVersion`, which expo-constants does not have. `Constants` is typed
// `& Record<string, any>`, so it compiled, returned undefined on every device forever, and the one
// indicator of whether the native CallKit fix was installed never rendered once.
//
// buildLabel was never broken, so a test of buildLabel could never have caught it. This pins the
// thing that was: the value comes from expo-application and it reaches the wire.
jest.mock("expo-application", () => ({ nativeBuildVersion: "5" }));
jest.mock("../src/lib/session");

import * as session from "../src/lib/session";
import { registerPushToken } from "../src/lib/api";
import { OTA_BUILD, NATIVE_BUILD, buildLabel } from "../src/lib/build";

describe("reporting which build this handset runs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (session.getToken as jest.Mock).mockResolvedValue("tok");
  });

  it("reads the native build from expo-application, not expo-constants", () => {
    expect(NATIVE_BUILD).toBe("5");
    expect(buildLabel(NATIVE_BUILD)).toBe(`#${OTA_BUILD} · b5`);
  });

  it("sends both builds with the push token, since that is the one call every launch makes", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve(""),
    } as Response);
    (global as any).fetch = fetchMock;

    await registerPushToken("ExponentPushToken[abc]", "ios");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/push/register");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.nativeBuild).toBe("5");
    expect(body.otaBuild).toBe(OTA_BUILD);
  });
});
