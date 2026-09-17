"use strict";

// What's new, shown once after an update installs. A version with no entry here shows nothing,
// which is the right default for a shell rebuild that changes nothing staff would notice.
//
// Kept out of main.js so the "which notes does this launch show" decision can be tested without
// Electron -- see test/desktop/releaseNotes.test.ts.
const RELEASE_NOTES = {
  "1.2.1": [
    "An incoming call raises one notification instead of two, and it shows the caller's name rather than their number.",
    "Opening TCB Phone while it is already running brings the existing window forward instead of starting a second copy.",
  ],
  "1.2.2": ["This window: after an update installs, the app now tells you what changed."],
};

// Sorts like a human reads it: 1.10.0 is newer than 1.9.0, which a string compare gets backwards.
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Every version's notes between what ran last time and what is running now -- NOT just the current
// one. Auto-update polls every six hours and a machine can be off for a week, so a desk routinely
// jumps two or three versions at once and the notes in between would otherwise never be seen.
//
// No previous version recorded means a fresh install rather than an update: nothing to announce.
function notesToShow(previousVersion, currentVersion, notes = RELEASE_NOTES) {
  if (!previousVersion || compareVersions(previousVersion, currentVersion) >= 0) return [];
  return Object.keys(notes)
    .filter((v) => compareVersions(v, previousVersion) > 0 && compareVersions(v, currentVersion) <= 0)
    .sort(compareVersions)
    .flatMap((v) => notes[v]);
}

module.exports = { RELEASE_NOTES, notesToShow, compareVersions };
