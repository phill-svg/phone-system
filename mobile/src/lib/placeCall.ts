import { Alert } from "react-native";
import { router } from "expo-router";
import { callViaMobile } from "./api";
import type { UserSettings } from "./api";

// Suppresses a second dial to the SAME number moments after the first.
//
// Reported as "the dial from mobile worked but it rang my mobile twice", and the calls table had
// two outbound legs to the same customer two seconds apart. Nothing retries -- the app sent the
// request twice, because none of the five call sites guards the button and the only feedback
// ("Calling your mobile") is an Alert that appears AFTER the round trip. So the tap looks like it
// did nothing, you tap again, and Twilio rings you twice for one call.
//
// Deliberately TIME-based rather than an in-flight flag. apiFetch has no timeout, so a request
// that never settles would pin an in-flight flag forever and dialling would stop working with no
// way back -- the same wedge hazard that got a latch removed from crashReport.ts. A window cannot
// wedge: it clears itself whether or not anything ever comes back.
const DUPLICATE_WINDOW_MS = 5000;
let lastDial: { target: string; at: number } | null = null;

export function isDuplicateDial(target: string, now: number): boolean {
  return lastDial !== null && lastDial.target === target && now - lastDial.at < DUPLICATE_WINDOW_MS;
}

// Test seam: the window is real time, so a test needs to be able to clear it.
export function resetDialGuard(): void {
  lastDial = null;
}

// One decision, made in one place: does this call go over VoIP (the in-app softphone) or over the
// carrier (Twilio rings your mobile, then bridges the customer)?
//
// Every dial in the app routes through here so the two paths can never drift apart -- a contact
// tapped from the thread screen has to behave like the same contact tapped on the keypad. It is
// also the one choke point where a duplicate can be stopped for all five call sites at once.
export async function placeCall(opts: {
  number: string;
  name?: string;
  from?: string;
  settings: UserSettings;
}): Promise<void> {
  const target = opts.number.trim();
  if (!target) return;

  const now = Date.now();
  if (isDuplicateDial(target, now)) return;
  lastDial = { target, at: now };

  // The toggle alone isn't enough: without a mobile number there is nothing to ring, and silently
  // falling back to VoIP would be worse than saying so.
  if (!opts.settings.call_via_mobile || !opts.settings.mobile_number.trim()) {
    router.push({ pathname: "/call-active", params: { number: target, name: opts.name ?? "", from: opts.from ?? "" } });
    return;
  }

  try {
    const { ringing } = await callViaMobile(target, opts.from);
    Alert.alert(
      "Calling your mobile",
      `Answer the call to ${formatRinging(ringing)} and we'll connect ${opts.name || target}.\n\nIt will show as the office number.`
    );
  } catch (e) {
    Alert.alert("Couldn't start the call", e instanceof Error ? e.message : "Try again in a moment.");
  }
}

function formatRinging(e164: string): string {
  return e164.startsWith("+61") ? `0${e164.slice(3)}` : e164;
}
