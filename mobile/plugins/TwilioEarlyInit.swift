// TwilioEarlyInit — appended to the generated AppDelegate.swift by withTwilioEarlyInit.js.
//
// WHAT THIS FIXES (2026-09-10, two device crash logs):
//
//   exception:   EXC_CRASH / SIGKILL
//   termination: namespace FRONTBOARD, code 0xBAADCA11
//   procRole:    "Non UI"        <- launched in the background
//   isLocked:    1               <- in a pocket, lockStateDuration 9310s
//   launched 10:01:40.5 -> killed 10:01:48.0
//
// 0xBAADCA11 is iOS's CallKit watchdog. A VoIP push launches the app in the background and
// gives it a few seconds to report the call to CallKit, or FrontBoard kills the process. The
// second log sits exactly between `ring_started` (10:01:38) and `no_answer` (10:02:00) on a
// real customer's call: the handset was not ignoring them, it was being killed, and they
// were sent to voicemail.
//
// The incoming-call path is entirely native once it is running -- the PKPushRegistry posts an
// NSNotification, `TwilioVoiceReactNative` observes it, hands the payload to the Twilio SDK
// and reports the call to CallKit. No JavaScript is involved. What IS gated on JavaScript is
// the existence of both halves:
//
//   * the PKPushRegistry, created only by `initializePushRegistry`, which the SDK exposes to
//     JS alone (its own expo-module.config.json is `"platforms": ["android"]`);
//   * and `TwilioVoiceReactNative` ITSELF. This app runs the New Architecture (reanimated 4
//     requires it), where legacy native modules are created lazily, the first time JS touches
//     `NativeModules.TwilioVoiceReactNative` -- i.e. after Hermes has evaluated the bundle.
//
// So on a cold launch from a VoIP push, nothing was listening for the push until the whole JS
// bundle had booted, which does not fit in the watchdog's budget. Priming the registry
// earlier in JS (which we already do, at module scope) does not help on its own: under the
// New Architecture the module that has to receive the push is created at that same moment.
//
// This creates the module during NATIVE launch instead, before the bundle loads, and primes
// its push registry there.
//
// WHY THIS DOES NOT END UP WITH TWO CALLKIT PROVIDERS -- the trap that makes the obvious
// version of this fix worse than the bug. `TwilioVoiceReactNative.init` calls
// `initializeCallKit` and `subscribeToNotifications`, so a second instance means two
// CXProviders and two observers racing over the same call. React Native asks its TurboModule
// delegate for pre-built legacy modules first (`RCTTurboModuleManager` ->
// `_legacyEagerlyInitializedModules`, populated from `extraModulesForBridge:` and consulted
// BEFORE the `[moduleClass new]` fallback), so handing our instance back from
// `extraModulesForBridge:` is what makes React Native adopt it rather than build its own.
// That chain is RCTTurboModuleManager -> RCTInstance -> ExpoReactNativeFactory -> this
// delegate; each link forwards only if the next responds to the selector, which is why this
// method has to exist on the app's own delegate class.
//
// Reached by selector rather than by importing the SDK's header: the class lives in a pod the
// app target does not link headers from, and `NSClassFromString` degrades to "no early init,
// behave exactly as before" if the SDK is ever removed or renamed, instead of failing the
// build.

@objc(TCBTwilioEarlyInit)
final class TCBTwilioEarlyInit: NSObject {
  private static let twilioModuleClassName = "TwilioVoiceReactNative"
  private static let initializeRegistry = "initializePushRegistry"

  private static let lock = NSLock()
  private static var cachedInstance: NSObject?

  /// The single `TwilioVoiceReactNative` instance, created on first call and primed for
  /// PushKit. Returns nil if the SDK is not present, in which case React Native falls back to
  /// creating the module itself, exactly as it did before this existed.
  @objc static func moduleInstance() -> NSObject? {
    lock.lock()
    defer { lock.unlock() }

    if let cachedInstance {
      return cachedInstance
    }
    guard let moduleClass = NSClassFromString(twilioModuleClassName) as? NSObject.Type else {
      NSLog("[TCBTwilioEarlyInit] %@ not found; incoming calls will initialise with JS.",
            twilioModuleClassName)
      return nil
    }

    // init() runs the SDK's -init: CallKit provider, notification observers, audio devices.
    let module = moduleClass.init()
    cachedInstance = module

    let selector = NSSelectorFromString(initializeRegistry)
    guard module.responds(to: selector) else {
      NSLog("[TCBTwilioEarlyInit] %@ has no %@; PushKit registry not primed natively.",
            twilioModuleClassName, initializeRegistry)
      return module
    }

    // PKPushRegistry is built on dispatch_get_main_queue() inside the SDK. React Native asks
    // for extra modules from the thread that starts the React host, which is the main thread
    // today; dispatching rather than asserting keeps that from mattering. Never sync -- a
    // deadlock here would hang launch, which is the failure this whole file exists to avoid.
    if Thread.isMainThread {
      _ = module.perform(selector)
    } else {
      DispatchQueue.main.async { _ = module.perform(selector) }
    }
    return module
  }
}

extension ReactNativeDelegate {
  /// `RCTBridgeDelegate.extraModulesForBridge:`, which React Native treats as the list of
  /// legacy native modules the app has already built. Called once while the React host starts
  /// up and before the JS bundle is evaluated, which is the whole point: creating the module
  /// here is what gets CallKit and PushKit listening during native launch.
  ///
  /// `bridge` is typed loosely because it is always nil under the New Architecture and typing
  /// it would drag React's headers into this file for no gain.
  @objc(extraModulesForBridge:)
  func tcbExtraModulesForBridge(_ bridge: AnyObject?) -> NSArray {
    guard let module = TCBTwilioEarlyInit.moduleInstance() else {
      return NSArray()
    }
    return [module] as NSArray
  }
}
