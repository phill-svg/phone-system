// TwilioEarlyInit -- the native half of the CallKit cold-launch fix, and a TEMPLATE rather than a
// compilable file. mobile/plugins/withTwilioEarlyInit.js splits it on the markers below and injects
// the pieces into the AppDelegate that `expo prebuild` generates. Everything above the first marker
// describes this file and is injected nowhere.
//
//   tcb:launch-call -> one line inside `application(_:didFinishLaunchingWithOptions:)`, placed
//                      before `startReactNative` so it runs before the React host exists.
//   tcb:file-scope  -> the helper class, after the delegate class.
//
// WHY THE METHOD IS ADDED WITH THE OBJC RUNTIME RATHER THAN WRITTEN IN SWIFT. Three builds died
// trying to declare it (2026-09-10):
//
//   1. in an `extension` -> "overriding declaration requires an 'override' keyword", and `override`
//      is legal in a class body and nowhere else;
//   2. in the class body returning `[any RCTBridgeModule]` -> "cannot find type 'RCTBridgeModule'
//      in scope";
//   3. in the class body returning `[Any]` -> "method does not override any method from its
//      superclass".
//
// 2 and 3 together are a catch-22, and `RCTBridgeDelegate.h` says why: it only FORWARD-DECLARES
// `@protocol RCTBridgeModule;`. Swift imports a forward-declared ObjC protocol as an opaque
// placeholder -- it participates in signature matching, so `[Any]` does not match, but it cannot be
// written down, so the matching signature cannot be spelled either. (`RCTBridgeModule.h` itself is
// no help: it imports `"RCTBundleManager.h"` with quotes, which makes it non-modular and keeps it
// out of the `React` module.) There is no Swift declaration that compiles.
//
// `class_addMethod` has no such problem. The selector, the type encoding and the block signature
// are all plain Objective-C, and a method added this way is what `respondsToSelector:` answers --
// which is the only thing React Native actually asks. It is also self-limiting: `class_addMethod`
// returns false and changes nothing if the method already exists, so a future React Native that
// implements it wins by default.

// tcb:launch-call
    // Adds `extraModulesForBridge:` to the delegate before the React host is built, which is what
    // gets the Twilio module (and its PushKit registry) alive during native launch. See
    // mobile/plugins/TwilioEarlyInit.swift.
    TCBTwilioEarlyInit.install(on: __TCB_DELEGATE__)

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
  private static let extraModulesSelector = "extraModulesForBridge:"

  private static let lock = NSLock()
  private static var handedOut = false

  /// Adds `extraModulesForBridge:` to the delegate's class at runtime.
  ///
  /// React Native asks its TurboModule delegate for modules the app has already built, and it only
  /// asks a delegate that `respondsToSelector:` -- which is exactly what a method added here
  /// satisfies. Returns false, changing nothing, if the class already implements it: a React Native
  /// that grows its own implementation keeps it.
  @discardableResult
  static func install(on delegate: AnyObject) -> Bool {
    guard let delegateClass: AnyClass = object_getClass(delegate) else { return false }

    // `@convention(block)` with only id/NSArray types, so nothing here needs a React header.
    let body: @convention(block) (AnyObject?, AnyObject?) -> NSArray = { _, _ in
      guard let module = TCBTwilioEarlyInit.adoptedModule() else {
        return NSArray()
      }
      return [module] as NSArray
    }

    // "@@:@" -- returns id, takes self, _cmd and one id (the bridge, nil under the New Architecture).
    let added = class_addMethod(
      delegateClass,
      NSSelectorFromString(extraModulesSelector),
      imp_implementationWithBlock(body),
      "@@:@"
    )
    if !added {
      NSLog("[TCBTwilioEarlyInit] %@ already implements %@; leaving it alone.",
            NSStringFromClass(delegateClass), extraModulesSelector)
    }
    return added
  }

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
