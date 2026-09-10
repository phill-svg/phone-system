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
    expect(out).toContain("@objc(extraModulesForBridge:)");
    expect(out).not.toContain("extension ReactNativeDelegate {");
    // The original file survives ahead of the injection.
    expect(out.startsWith(APP_DELEGATE.trimEnd())).toBe(true);
  });

  it("carries a token to rewrite, so the rewrite is not silently a no-op", () => {
    // If TwilioEarlyInit.swift stops naming the placeholder, the substitution above lands on
    // nothing and the extension is emitted against whatever the file happens to say.
    expect(swift).toContain("extension ReactNativeDelegate {");
  });

  it("is safe to run again over an already-patched AppDelegate", () => {
    const once = injectTwilioEarlyInit(APP_DELEGATE, swift);
    const twice = injectTwilioEarlyInit(once, swift);

    expect(twice).toBe(once);
    // Two declarations of the same class would not compile, which is the failure this prevents.
    expect(twice.match(/class TCBTwilioEarlyInit/g)).toHaveLength(1);
  });

  it("throws when the Expo template no longer declares a factory delegate", () => {
    expect(() =>
      injectTwilioEarlyInit("import Expo\n\nclass AppDelegate: ExpoAppDelegate {}\n", swift)
    ).toThrow(/ExpoReactNativeFactoryDelegate/);
  });
});
