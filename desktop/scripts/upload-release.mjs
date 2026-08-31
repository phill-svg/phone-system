#!/usr/bin/env node
// Publish the built desktop release to R2, where the app's auto-updater looks for it.
//
// electron-updater polls https://tcbvoip.app/desktop/latest.yml (see build.publish in
// package.json). That path is served by the worker out of the R2 bucket under a `desktop/` prefix,
// so "publishing" is just putting three files there:
//   latest.yml            the manifest the updater polls
//   *.exe                 the installer it downloads
//   *.exe.blockmap        lets it fetch only the changed chunks instead of the whole 95MB
//
// Usage:
//   npm run build && npm run release:upload
//
// The manifest is uploaded LAST on purpose: it is the switch that makes the new version visible,
// so the installer it points at must already be in place. Uploading it first would advertise a
// version that 404s for anyone who checked in that window.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const releaseDir = join(desktopDir, "release");
const BUCKET = "tcb-voip-audio";
const PREFIX = "desktop";

const { version } = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const installer = `TCB-Phone-Setup-${version}.exe`;

// Order matters: manifest last. See the note above.
const files = [installer, `${installer}.blockmap`, "latest.yml"];

for (const name of files) {
  const path = join(releaseDir, name);
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run "npm run build" first.`);
    process.exit(1);
  }
}

const useShell = process.platform === "win32"; // npx.cmd needs a shell
// A shell re-splits arguments on whitespace, so anything that could contain a space is quoted.
const quote = (value) => (useShell ? JSON.stringify(value) : value);

console.log(`Publishing TCB Phone ${version} to r2://${BUCKET}/${PREFIX}/\n`);

for (const name of files) {
  const key = `${BUCKET}/${PREFIX}/${name}`;
  console.log(`  ${name}`);
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", quote(key), `--file=${quote(join(releaseDir, name))}`],
    { stdio: "inherit", cwd: desktopDir, shell: useShell }
  );
}

console.log(`\n✅ ${version} published. Running copies will pick it up within six hours,`);
console.log("   or immediately on their next launch.");
