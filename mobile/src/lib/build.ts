// The OTA build number shown in Settings → Check for Updates.
//
// It lives here rather than in the settings screen because crash reports carry it too: "which build
// was this?" is the first question asked of any crash, and the answer has to come from the same
// constant the handset displays, or the two can disagree.
//
// The publish workflow greps this file's value, so keep the literal on one line.
export const OTA_BUILD = "67";

// What Settings shows, and the only way to tell whether a NATIVE fix is on a handset.
//
// `OTA_BUILD` cannot answer that on its own: an OTA reaches every binary on the same
// `runtimeVersion` (policy `appVersion`, so 1.0.0 for all of them), so a handset on an older
// build happily reports the newest OTA number while missing everything that shipped natively --
// the AppDelegate patch in `plugins/withTwilioEarlyInit.js` above all, which an OTA can never
// deliver. `nativeBuildVersion` is CFBundleVersion on iOS and versionCode on Android: the
// identity of the installed binary. It is null in some contexts (Expo Go), where the OTA number
// alone is all there is to show.
export function buildLabel(nativeBuildVersion: string | null): string {
  return nativeBuildVersion ? `#${OTA_BUILD} · b${nativeBuildVersion}` : `#${OTA_BUILD}`;
}
