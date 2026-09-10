import fs from "fs";

import { injectTwilioEarlyInit, SWIFT_SOURCE } from "../plugins/withTwilioEarlyInit";

// A stand-in for what `expo prebuild` writes, trimmed to the parts the plugin looks at. The
// delegate variable is deliberately NOT called `delegate`, so a fixture cannot pass by accident on
// the template's own name.
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
    let rnDelegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: rnDelegate)
    rnDelegate.dependencyProvider = RCTAppDependencyProvider()

    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func bundleURL() -> URL? {
    return nil
  }
}
`;

const swift = fs.readFileSync(SWIFT_SOURCE, "utf8");

describe("injectTwilioEarlyInit", () => {
  it("installs before startReactNative, using the delegate the file actually declares", () => {
    // Timing is the whole point: after the React host is built, the module React Native asks for
    // has already been created by React Native itself.
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);

    expect(out).toContain("TCBTwilioEarlyInit.install(on: rnDelegate)");
    expect(out).not.toContain("__TCB_DELEGATE__");
    expect(out.indexOf("TCBTwilioEarlyInit.install")).toBeLessThan(
      out.indexOf("factory.startReactNative")
    );
    expect(out.indexOf("TCBTwilioEarlyInit.install")).toBeGreaterThan(out.indexOf("let rnDelegate ="));
  });

  it("declares no delegate method in Swift, because no Swift signature can match", () => {
    // RCTBridgeDelegate.h only forward-declares `@protocol RCTBridgeModule;`, which Swift imports as
    // an opaque placeholder: it participates in signature matching (so `[Any]` does not match) but
    // cannot be written down (so the matching signature cannot be spelled). Three builds died on
    // that catch-22 before the method was added with class_addMethod instead.
    // Checked against the INJECTED output, which is what the compiler sees -- the template's
    // preamble explains all this in prose and is dropped.
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);
    expect(out).not.toContain("RCTBridgeModule");
    expect(out).not.toContain("func extraModules(");
    expect(out).toContain("class_addMethod(");
  });

  it("imports ObjectiveC, without which the runtime calls do not resolve", () => {
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);
    expect(out).toContain("\nimport ObjectiveC\n");
    expect(out.indexOf("import ObjectiveC")).toBeLessThan(out.indexOf("@UIApplicationMain"));
  });

  it("keeps the helper class at file scope, after the delegate", () => {
    const out = injectTwilioEarlyInit(APP_DELEGATE, swift);

    expect(out).toContain("\nfinal class TCBTwilioEarlyInit {");
    expect(out.indexOf("final class TCBTwilioEarlyInit")).toBeGreaterThan(
      out.indexOf("class ReactNativeDelegate:")
    );
    expect(out.startsWith("import Expo\nimport React")).toBe(true);
    expect(out).toContain("override func bundleURL() -> URL? {");
  });

  it("replaces every injection on a re-run rather than skipping or duplicating them", () => {
    // Prebuild runs repeatedly over an existing ios/ tree. Skipping when already patched would pin
    // the first copy: edit the Swift, re-run prebuild, and build the stale version.
    const once = injectTwilioEarlyInit(APP_DELEGATE, swift);
    const edited = swift.replace(/TwilioVoiceReactNative/g, "TwilioVoiceReactNativeV2");
    const twice = injectTwilioEarlyInit(once, edited);

    expect(twice).toContain("TwilioVoiceReactNativeV2");
    expect(twice).not.toContain('"TwilioVoiceReactNative"');
    expect(twice.match(/final class TCBTwilioEarlyInit/g)).toHaveLength(1);
    expect(twice.match(/TCBTwilioEarlyInit\.install/g)).toHaveLength(1);
    expect(twice.match(/^import ObjectiveC$/gm)).toHaveLength(1);
    expect(injectTwilioEarlyInit(once, swift)).toBe(once);
    expect(twice.startsWith("import Expo\nimport React")).toBe(true);
  });

  it("throws when the Expo template no longer builds the factory the same way", () => {
    expect(() =>
      injectTwilioEarlyInit("import Expo\n\nclass AppDelegate: ExpoAppDelegate {}\n", swift)
    ).toThrow(/ExpoReactNativeFactory/);
  });

  it("throws when the Swift template loses a split marker", () => {
    expect(() =>
      injectTwilioEarlyInit(APP_DELEGATE, swift.replace(/\/\/ tcb:file-scope/g, ""))
    ).toThrow(/tcb:file-scope/);
    expect(() =>
      injectTwilioEarlyInit(APP_DELEGATE, swift.replace(/\/\/ tcb:launch-call/g, ""))
    ).toThrow(/tcb:launch-call/);
  });
});

describe("app config", () => {
  it("registers the plugin, without which prebuild emits an unpatched AppDelegate", () => {
    const appConfig = require("../app.json");
    expect(appConfig.expo.plugins).toContain("./plugins/withTwilioEarlyInit");
  });
});
