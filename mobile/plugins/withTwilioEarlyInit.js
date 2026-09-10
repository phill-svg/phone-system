// Appends TwilioEarlyInit.swift to the AppDelegate that `expo prebuild` generates, so the
// Twilio voice module and its PushKit registry are built during NATIVE launch instead of
// after the JS bundle has booted. The why is in TwilioEarlyInit.swift; this file is only the
// mechanics of getting it there.
//
// It is appended to AppDelegate.swift rather than shipped as a local Expo module because the
// code has to extend the app's OWN React Native delegate class: React Native only asks a
// delegate for pre-built modules if that delegate responds to `extraModulesForBridge:`, and
// an extension in another module would need that class to be extendable across module
// boundaries. Same file, same module, no doubt.
const fs = require("fs");
const path = require("path");
const { withAppDelegate } = require("expo/config-plugins");

const SWIFT_SOURCE = path.join(__dirname, "TwilioEarlyInit.swift");

// The token TwilioEarlyInit.swift is written against. Expo names this class
// `ReactNativeDelegate` in the SDK 54 template; it is rewritten to whatever the generated
// file actually calls it, so a template rename fails loudly at prebuild rather than compiling
// into an extension of a class nothing uses.
const DELEGATE_TOKEN = /\bReactNativeDelegate\b/g;
const DELEGATE_DECLARATION = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*ExpoReactNativeFactoryDelegate\b/;

// Injecting twice would declare TCBTwilioEarlyInit twice and fail to compile. Prebuild runs
// repeatedly against an existing ios/ directory, so this has to be safe to re-run.
const INJECTED_MARKER = "TCBTwilioEarlyInit";

/**
 * @param {string} contents  the generated AppDelegate.swift
 * @param {string} swift     the contents of TwilioEarlyInit.swift
 * @returns {string}
 */
function injectTwilioEarlyInit(contents, swift) {
  if (contents.includes(INJECTED_MARKER)) return contents;

  const match = contents.match(DELEGATE_DECLARATION);
  if (!match) {
    throw new Error(
      "withTwilioEarlyInit: no `class <Name>: ExpoReactNativeFactoryDelegate` in AppDelegate.swift. " +
        "The Expo template changed shape; update mobile/plugins/withTwilioEarlyInit.js to match it. " +
        "Without this the app takes no incoming calls on a cold launch (see TwilioEarlyInit.swift)."
    );
  }

  return `${contents.trimEnd()}\n\n${swift.replace(DELEGATE_TOKEN, match[1]).trimEnd()}\n`;
}

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withTwilioEarlyInit = (config) =>
  withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error(
        `withTwilioEarlyInit: expected a Swift AppDelegate, got ${config.modResults.language}.`
      );
    }
    config.modResults.contents = injectTwilioEarlyInit(
      config.modResults.contents,
      fs.readFileSync(SWIFT_SOURCE, "utf8")
    );
    return config;
  });

module.exports = withTwilioEarlyInit;
module.exports.injectTwilioEarlyInit = injectTwilioEarlyInit;
module.exports.SWIFT_SOURCE = SWIFT_SOURCE;
