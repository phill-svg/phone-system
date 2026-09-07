import { Alert } from "react-native";
import { router } from "expo-router";
import { callViaMobile } from "./api";
import type { UserSettings } from "./api";

// One decision, made in one place: does this call go over VoIP (the in-app softphone) or over the
// carrier (Twilio rings your mobile, then bridges the customer)?
//
// Every dial in the app routes through here so the two paths can never drift apart -- a contact
// tapped from the thread screen has to behave like the same contact tapped on the keypad.
export async function placeCall(opts: {
  number: string;
  name?: string;
  from?: string;
  settings: UserSettings;
}): Promise<void> {
  const target = opts.number.trim();
  if (!target) return;

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
