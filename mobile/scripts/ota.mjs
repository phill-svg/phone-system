#!/usr/bin/env node
// Publish an EAS OTA update to BOTH channels our test devices use, in one command.
//
// Why this exists: our two test devices are on DIFFERENT EAS channels —
//   Android = `preview` (dev/internal build)
//   iOS     = `production` (the TestFlight `store` build)
// so `eas update --branch preview` alone reaches ONLY Android and iOS silently
// stays on the old build number. This script always hits both branches.
//
// Usage:
//   npm run ota -- "call transcript + outcome and notes"
// The current OTA_BUILD from settings.tsx is read automatically and prepended as
// `#<n>` to the message, so the number a device shows always matches what shipped.
//
// ⚠️ App Store review caveat: the `production` channel serves the `store` build.
// If that build is in ACTIVE App Store review, DO NOT run this (OTA'ing a build
// under review violates Apple's guidelines and can sink the submission). Only
// publish to `production` when the store build is TestFlight-only or already live.
// Pass `--preview-only` to skip the production publish while a build is in review.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, "..", "src", "app", "(tabs)", "settings.tsx");

const args = process.argv.slice(2);
const previewOnly = args.includes("--preview-only");
const description = args.filter((a) => a !== "--preview-only").join(" ").trim();

if (!description) {
  console.error('Usage: npm run ota -- "short description of the update" [--preview-only]');
  process.exit(1);
}

// Pull the current OTA_BUILD so the message number always matches what's on-device.
const settings = readFileSync(settingsPath, "utf8");
const match = settings.match(/OTA_BUILD\s*=\s*["'](\d+)["']/);
if (!match) {
  console.error(`Could not find OTA_BUILD in ${settingsPath}. Bump it before publishing.`);
  process.exit(1);
}
const buildNo = match[1];
const message = `#${buildNo} ${description}`;

const branches = previewOnly ? ["preview"] : ["preview", "production"];

console.log(`\nPublishing OTA ${message}`);
console.log(`Channels: ${branches.join(", ")}`);
if (!previewOnly) {
  console.log(
    "\n⚠️  Publishing to `production` too (iOS store build). If that build is in " +
      "ACTIVE App Store review, STOP now and re-run with --preview-only.\n"
  );
}

for (const branch of branches) {
  console.log(`\n=== eas update --branch ${branch} ===`);
  execFileSync("npx", ["eas", "update", "--branch", branch, "--message", message], {
    stdio: "inherit",
    cwd: join(here, ".."),
    shell: process.platform === "win32", // npx.cmd on Windows
  });
}

console.log(`\n✅ Published ${message} to: ${branches.join(", ")}`);
console.log("On each device: Settings → Check for Updates, then fully restart the app.");
