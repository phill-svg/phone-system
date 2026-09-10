// TwilioEarlyInit -- the native half of the CallKit cold-launch fix, and a TEMPLATE rather than a
// compilable file. mobile/plugins/withTwilioEarlyInit.js splits it on the two markers below and
// injects the halves into the AppDelegate that `expo prebuild` generates. Everything above the
// first marker describes this file and is injected nowhere.
//
//   tcb:class-body  -> goes INSIDE the generated delegate class. It has to: the method is an
//                      `override`, and Swift permits an overriding declaration in a class body and
//                      nowhere else. Build 5 (2026-09-10) failed to compile for exactly that,
//                      "overriding declaration requires an 'override' keyword", when this lived in
//                      an `extension` -- where adding the keyword is not allowed either.
//   tcb:file-scope  -> goes after that class, at file scope.
//
// It also names no React protocol. `RCTBridgeModule` is NOT visible to Swift from the app target:
// `RCTBridgeModule.h` imports `"RCTBundleManager.h"` with quotes, which makes it non-modular, so
// clang leaves it out of the `React` module that `import React` brings in -- `RCTBridge` resolves
// and `RCTBridgeModule` does not. Build 5's second attempt died on exactly that, four times over
// (`cannot find type 'RCTBridgeModule' in scope`). Swift imports the requirement's
// `NSArray<id<RCTBridgeModule>> *` as `[Any]` for the same reason, which is what the override has
// to match, and `adoptedModule()` hands back a plain `NSObject`.
//
// The method does NOT call super. `extraModulesForBridge:` is an @optional requirement of
// RCTBridgeDelegate that nothing in the chain implements -- which is why React Native guards every
// call to it with respondsToSelector: -- so Swift sees an inherited declaration to override while
// the runtime has no implementation behind it, and a super call would be a message to an
// unimplemented selector.

// tcb:class-body
  /// `RCTBridgeDelegate.extraModulesForBridge:` -- the list of native modules the app has
  /// already built. React Native asks for it while the React host starts and before the JS
  /// bundle is evaluated, which is the whole point: building the module here is what gets
  /// CallKit and PushKit listening during native launch.
  ///
  /// `bridge` is nil under the New Architecture and is not used; the signature matches the
  /// imported protocol requirement, which is what makes this an override rather than a new
  /// method under the same selector.
  @objc
  override func extraModules(for bridge: RCTBridge) -> [Any] {
    guard let module = TCBTwilioEarlyInit.adoptedModule() else {
      return []
    }
    return [module]
  }

// tcb:file-scope
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

final class TCBTwilioEarlyInit {
  private static let twilioModuleClassName = "TwilioVoiceReactNative"
  private static let initializeRegistry = "initializePushRegistry"
  private static let turboModuleProtocolName = "RCTTurboModule"

  private static let lock = NSLock()
  private static var handedOut = false

  /// Builds the Twilio module and primes its PushKit registry, for React Native to adopt.
  /// Returns nil to mean "build it yourself, exactly as before" -- every way this can fail
  /// takes that exit, because the fallback is the behaviour that shipped for months and a
  /// half-applied version of this is worse than none.
  static func adoptedModule() -> NSObject? {
    lock.lock()
    defer { lock.unlock() }

    // Handed out ONCE. React Native's own contract for this method is "always return a new
    // instance for each call, rather than returning the same instance each time the bridge is
    // reloaded" (RCTBridgeDelegate.h), and a module carries per-JS-context state: callMap,
    // callInviteMap, the device token, the event-emitter listener count. A reload -- an OTA
    // install, a dev refresh -- is not a cold VoIP launch and does not need this, so after the
    // first React host we stand aside. Set before the guards below, so a lookup that fails is
    // remembered rather than repeated on every host.
    if handedOut { return nil }
    handedOut = true

    guard let moduleType = NSClassFromString(twilioModuleClassName) as? NSObject.Type else {
      NSLog("[TCBTwilioEarlyInit] %@ not found; incoming calls will initialise with JS.",
            twilioModuleClassName)
      return nil
    }

    // -init sets up CallKit, the audio session and the notification observers, which is why
    // the module declares `requiresMainQueueSetup` YES. React Native asks for extra modules
    // while it starts the React host, on the main thread. If that ever changes, stand down
    // rather than either doing this work off the main queue or blocking on it: a deadlock
    // here would hang launch, which is the failure this whole file exists to prevent.
    guard Thread.isMainThread else {
      NSLog("[TCBTwilioEarlyInit] not on the main thread; leaving %@ to React Native.",
            twilioModuleClassName)
      return nil
    }

    let module = moduleType.init()

    // If the SDK ever becomes a TurboModule, React Native DISCARDS a handed-back instance that
    // conforms to RCTTurboModule and builds its own (RCTTurboModuleManager's
    // `isTurboModuleInstance` check) -- leaving ours alive as a second CallKit provider and a
    // second observer of the push notification, which is the trap this design exists to avoid.
    // The package is pinned on a caret range, so a routine install can move it. Dropping our
    // only reference here deallocates the module, and its -dealloc removes those observers.
    if let turboModule = NSProtocolFromString(turboModuleProtocolName), module.conforms(to: turboModule) {
      NSLog("[TCBTwilioEarlyInit] %@ is a TurboModule now; leaving it to React Native.",
            twilioModuleClassName)
      return nil
    }

    let selector = NSSelectorFromString(initializeRegistry)
    if module.responds(to: selector) {
      _ = module.perform(selector)
    } else {
      NSLog("[TCBTwilioEarlyInit] %@ has no %@; PushKit registry not primed natively.",
            twilioModuleClassName, initializeRegistry)
    }

    return module
  }
}
