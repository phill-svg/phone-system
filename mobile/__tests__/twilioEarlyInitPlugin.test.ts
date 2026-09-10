import fs from "fs";

import { injectTwilioEarlyInit, SWIFT_SOURCE } from "../plugins/withTwilioEarlyInit";

// A stand-in for what `expo prebuild` writes, trimmed to the parts the plugin looks at. The
// delegate is deliberately NOT called ReactNativeDelegate, so a fixture cannot pass by accident on
// the template's default name.
const APP_DELEGATE = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class RenamedDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func bundleURL() -> URL? {
    return nil
  }
}
`;

const swift = fs.readFileSync(SWIFT_SOURCE, "utf8");

/** The delegate class body, which is the only place an `override` may legally live. */
function classBodyOf(contents: string): string {
  const start = contents.indexOf("class RenamedDelegate: ExpoReactNativeFactoryDelegate {");
  expect(start).toBeGreaterThan(-1);
  return contents.slice(start, contents.indexOf("\n}\n", start));
}

describe("injectTwilioEarlyInit", () => {
  it("puts the override inside the delegate class, where Swift allows one", () => {
    // Build 5 (2026-09-10) failed to compile because this method was emitted in an `extension`:
    // "overriding declaration requires an 'override' keyword", and `override` is illegal there.
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);

    expect(classBodyOf(out)).toContain(
      "override func extraModules(for bridge: RCTBridge) -> [any RCTBridgeModule]"
    );
    expect(out).not.toContain("extension RenamedDelegate");
  });

  it("keeps the helper class at file scope, after the delegate", () => {
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);

    expect(classBodyOf(out)).not.toContain("final class TCBTwilioEarlyInit");
    expect(out).toContain("\nfinal class TCBTwilioEarlyInit {");
    expect(out.indexOf("final class TCBTwilioEarlyInit")).toBeGreaterThan(
      out.indexOf("override func extraModules")
    );
    // The generated AppDelegate itself survives ahead of both.
    expect(out.startsWith("import Expo\nimport React")).toBe(true);
    expect(out).toContain("override func bundleURL() -> URL? {");
  });

  it("never calls super, because nothing in the chain implements the optional requirement", () => {
    // extraModulesForBridge: is @optional on RCTBridgeDelegate and unimplemented all the way up --
    // which is why React Native guards every call to it with respondsToSelector:. A super call
    // would be a message to an unimplemented selector at launch.
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);
    expect(out).not.toContain("super.extraModules");
  });

  it("replaces both injections on a re-run rather than skipping or duplicating them", () => {
    // Prebuild runs repeatedly over an existing ios/ tree. Skipping when already patched would pin
    // the first copy: edit the Swift, re-run prebuild, and read the stale version believing it was
    // the new one.
    const once = injectTwilioEarlyInit(APP_DELEGATE, swift);
    const edited = swift.replace(/TwilioVoiceReactNative/g, "TwilioVoiceReactNativeV2");
    const twice = injectTwilioEarlyInit(once, edited);

    expect(twice).toContain("TwilioVoiceReactNativeV2");
    expect(twice).not.toContain('"TwilioVoiceReactNative"');
    // Duplicates of either half would not compile.
    expect(twice.match(/final class TCBTwilioEarlyInit/g)).toHaveLength(1);
    expect(twice.match(/override func extraModules/g)).toHaveLength(1);
    expect(injectTwilioEarlyInit(once, swift)).toBe(once);
    expect(twice.startsWith("import Expo\nimport React")).toBe(true);
  });

  it("throws when the Expo template no longer declares a factory delegate", () => {
    expect(() =>
      injectTwilioEarlyInit("import Expo\n\nclass AppDelegate: ExpoAppDelegate {}\n", swift)
    ).toThrow(/ExpoReactNativeFactoryDelegate/);
  });

  it("throws when the Swift template loses a split marker", () => {
    expect(() =>
      injectTwilioEarlyInit(APP_DELEGATE, swift.replace(/\/\/ tcb:file-scope/g, ""))
    ).toThrow(/tcb:file-scope/);
    expect(() =>
      injectTwilioEarlyInit(APP_DELEGATE, swift.replace(/\/\/ tcb:class-body/g, ""))
    ).toThrow(/tcb:class-body/);
  });
});

describe("app config", () => {
  it("registers the plugin, without which prebuild emits an unpatched AppDelegate", () => {
    // Everything above tests the transformation in isolation; it runs at all only because app.json
    // asks for it. Drop that line in a merge and the app goes back to being killed on a cold VoIP
    // launch with every test, the typecheck and the EAS build still green.
    const appConfig = require("../app.json");
    expect(appConfig.expo.plugins).toContain("./plugins/withTwilioEarlyInit");
  });
});
