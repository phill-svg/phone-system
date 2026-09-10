/// <reference types="jest" />

// The 0xBAADCA11 crash: a VoIP push wakes the app in the background and iOS allows roughly five
// seconds to report the call to CallKit. The PushKit registry used to be created inside
// registerForIncoming -- behind auth, navigation, a permission check and a network round trip --
// so on the cold wake that a real incoming call actually is, the handset was killed instead of
// ringing. The registry must be created at launch, from module scope, touching nothing else.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "src");
const layout = fs.readFileSync(path.join(SRC, "app", "_layout.tsx"), "utf8");
const voice = fs.readFileSync(path.join(SRC, "lib", "voice.ts"), "utf8");

describe("PushKit registry timing", () => {
  it("primes the registry at module scope in the root layout, not inside a component", () => {
    expect(layout).toContain("primePushRegistry");
    // Module scope: it must appear before the first component declaration in the file.
    const primeAt = layout.indexOf("primePushRegistry()");
    const firstComponentAt = layout.search(/\nfunction [A-Z]|\nexport default function/);
    expect(primeAt).toBeGreaterThan(-1);
    expect(primeAt).toBeLessThan(firstComponentAt);
  });

  // If registerForIncoming creates it directly again, the ordering fix is only half applied --
  // exactly the shape of bug the tier 3 review caught on the ring path.
  it("does not create the registry a second time inside registerForIncoming", () => {
    const direct = voice.match(/voice\.initializePushRegistry\(\)/g) ?? [];
    expect(direct).toHaveLength(1);
    const primeFn = voice.indexOf("export function primePushRegistry");
    const callAt = voice.indexOf("voice.initializePushRegistry()");
    expect(callAt).toBeGreaterThan(primeFn);
  });

  // Startup must not be able to throw: a failure to build the registry means incoming calls will
  // not arrive, which the registration status surfaces -- it must not also stop the app opening.
  it("swallows a registry failure rather than throwing from app startup", () => {
    const fn = voice.slice(voice.indexOf("export function primePushRegistry"));
    expect(fn.slice(0, 600)).toContain(".catch(");
  });
});
