import fs from "fs";

import {
  injectTwilioEarlyInit,
  SWIFT_SOURCE,
} from "../plugins/withTwilioEarlyInit";

// A stand-in for what `expo prebuild` writes, trimmed to the parts the plugin looks at. The
// delegate is deliberately NOT called ReactNativeDelegate: the plugin has to rewrite the token
// in TwilioEarlyInit.swift to whatever the generated file actually declares, and a fixture using
// the default name would pass whether it rewrote anything or not.
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
  override func bundleURL() -> URL? {
    return nil
  }
}
`;

const swift = fs.readFileSync(SWIFT_SOURCE, "utf8");

describe("injectTwilioEarlyInit", () => {
  it("extends the delegate class the generated file actually declares", () => {
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);

    // This is the whole fix: React Native only asks a delegate for pre-built native modules if
    // that delegate responds to extraModulesForBridge:. Extending a class that does not exist
    // in the file would compile into nothing being asked.
    expect(out).toContain("extension RenamedDelegate {");
    expect(out).toContain("func extraModules(for bridge: RCTBridge) -> [any RCTBridgeModule]");
    expect(out).not.toContain("extension ReactNativeDelegate {");
    // The original file survives ahead of the injection.
    expect(out.startsWith(APP_DELEGATE.trimEnd())).toBe(true);
  });

  it("carries a token to rewrite, so the rewrite is not silently a no-op", () => {
    // If TwilioEarlyInit.swift stops naming the placeholder, the substitution above lands on
    // nothing and the extension is emitted against whatever the file happens to say.
    expect(swift).toContain("extension ReactNativeDelegate {");
  });

  it("replaces the previous injection rather than skipping or duplicating it", () => {
    // Prebuild runs repeatedly over an existing ios/ tree. Skipping when already patched would
    // pin the first copy: edit the Swift, re-run prebuild, and read the stale version while
    // believing you tested the new one.
    const once = injectTwilioEarlyInit(APP_DELEGATE, swift);
    const edited = swift.replace(/TwilioVoiceReactNative/g, "TwilioVoiceReactNativeV2");
    const twice = injectTwilioEarlyInit(once, edited);

    expect(twice).toContain("TwilioVoiceReactNativeV2");
    expect(twice).not.toContain('"TwilioVoiceReactNative"');
    // Two declarations of the same class would not compile, which is the other failure here.
    expect(twice.match(/class TCBTwilioEarlyInit/g)).toHaveLength(1);
    // Re-running with the same input is still a no-op in effect.
    expect(injectTwilioEarlyInit(once, swift)).toBe(once);
    // And the generated AppDelegate itself is never eaten by the round trip.
    expect(twice.startsWith(APP_DELEGATE.trimEnd())).toBe(true);
  });

  it("throws when the Expo template no longer declares a factory delegate", () => {
    expect(() =>
      injectTwilioEarlyInit("import Expo\n\nclass AppDelegate: ExpoAppDelegate {}\n", swift)
    ).toThrow(/ExpoReactNativeFactoryDelegate/);
  });
});

describe("app config", () => {
  it("registers the plugin, without which prebuild emits an unpatched AppDelegate", () => {
    // Everything above tests the transformation in isolation; it runs at all only because
    // app.json asks for it. Drop that line in a merge and the app goes back to being killed on
    // a cold VoIP launch with every test, the typecheck and the EAS build still green.
    const appConfig = require("../app.json");
    expect(appConfig.expo.plugins).toContain("./plugins/withTwilioEarlyInit");
  });
});
