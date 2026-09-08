// The OTA build number shown in Settings → Check for Updates.
//
// It lives here rather than in the settings screen because crash reports carry it too: "which build
// was this?" is the first question asked of any crash, and the answer has to come from the same
// constant the handset displays, or the two can disagree.
//
// The publish workflow greps this file's value, so keep the literal on one line.
export const OTA_BUILD = "53";
