import React, { useEffect, useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { router, useLocalSearchParams } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "../components/ui/Icon";
import { Avatar } from "../components/ui/Avatar";
import { useContactName } from "../lib/useContactName";
import { formatPhone } from "../lib/phone";
import { acceptIncoming, acceptWaitingCall, ringingScreenOnMount, rejectIncoming, onInviteCancelled, onInviteAccepted } from "../lib/voice";
import { reportError } from "../lib/crashReport";
import { haptics } from "../theme/haptics";
import { type } from "../theme/theme";

// How long to wait after mount before auto-accepting an invite when the user has "auto-answer"
// enabled. Gives a brief moment for the ringing UI to render before the call connects hands-free.
const AUTO_ANSWER_DELAY_MS = 1500;

function SecondaryAction({ icon, fallback, label, onPress }: { icon: SymbolViewProps["name"]; fallback: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondary}>
      <View style={styles.secondaryIcon}>
        <Icon name={icon} fallback={fallback as never} size={26} color="#FFFFFF" />
      </View>
      <Text style={styles.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

export default function IncomingCallScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ number?: string; name?: string; auto?: string; waiting?: string; preview?: string }>();
  const number = String(params.number ?? "");
  const name = String(params.name ?? "");
  const isAuto = params.auto === "1";
  const isWaiting = params.waiting === "1";
  // Display only. The effects below deliberately keep depending on the PARAM `name`, not this: a
  // name that arrives late would otherwise tear down and re-subscribe onInviteAccepted mid-ring,
  // and a missed accept there is the black-screen-over-a-live-call bug from #50/#51. The in-call
  // screen resolves the name itself, so nothing is lost by passing the raw param onward.
  const displayName = useContactName(number, name);
  const title = displayName || formatPhone(number) || "Unknown";

  // Guards the auto-answer timer so it doesn't fire after the user has already accepted or
  // declined (e.g. they tap Decline in the first second of a hands-free auto-answer window).
  const actedRef = useRef(false);

  // Leaving this screen must never pop an empty stack -- that renders as a black screen with no way
  // out, which is what a caller sees while actually connected. Fall back to the app root.
  function dismiss() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  async function answer() {
    if (actedRef.current) return;
    actedRef.current = true;
    try {
      // Inside the try, not before it: anything that can throw ahead of the actual accept() call
      // (haptics included) must never be able to abort this handler before it runs -- that is what
      // left the screen looking frozen with no feedback at all and no call connected.
      haptics.success();
      // Call waiting ends the current call, but only once the new invite is known to be answerable.
      const call = await (isWaiting ? acceptWaitingCall() : acceptIncoming());
      if (call) {
        router.replace({ pathname: "/call-active", params: { number, name, direction: "incoming" } });
        return;
      }
    } catch (e) {
      // Was a bare `catch {}`. The SDK throws InvalidStateError here when the invite was already
      // accepted natively, which used to dismiss the screen silently and strand a live call.
      console.warn("[call-incoming] accept failed", e);
      // console.warn alone reaches nobody -- non-fatal, so it queues locally and sends on next
      // launch the same way a crash report does, without needing this to have killed the app.
      reportError(e, false).catch(() => {});
    }
    dismiss();
  }
  function decline() {
    if (actedRef.current) return;
    actedRef.current = true;
    try {
      haptics.medium();
    } catch {
      // A failure to buzz must never stop the decline itself from running.
    }
    rejectIncoming().catch(() => {});
    dismiss();
  }
  // Decline, then open the conversation with the caller so a text can go out while the call rings on
  // to the team. Both buttons here used to only decline; "Remind Me" was removed rather than faked.
  function message() {
    if (actedRef.current) return;
    decline();
    router.push({ pathname: "/thread/[number]", params: { number } });
  }

  // The invite can already be settled by the time this mounts, and the listeners below only hear
  // about changes AFTER they subscribe -- which left a live Answer button on a dead invite. The
  // Settings preview has no invite at all, so it is exempt.
  useEffect(() => {
    if (params.preview === "1") return;
    const action = ringingScreenOnMount(isWaiting);
    if (action === "ring") return;
    actedRef.current = true;
    if (action === "in-call") router.replace({ pathname: "/call-active", params: { number, name, direction: "incoming" } });
    else dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The caller gave up (or another device took it) while this screen was up. Dismiss immediately:
  // leaving a live Answer button on a withdrawn invite is what makes the app abort -- accepting a
  // non-pending invite throws inside TwilioVoice's native CallKit path, which no JS catch can
  // reach. `actedRef` is set first so a racing auto-answer timer cannot fire on the way out.
  useEffect(() => {
    return onInviteCancelled(() => {
      if (actedRef.current) return;
      actedRef.current = true;
      dismiss();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Answered somewhere other than this screen -- CallKit's lock-screen/banner UI answers the call
  // without our JS being involved at all, and this screen would otherwise stay up, mid-conversation,
  // still showing a live Accept button. Tapping that accepts an already-accepted invite, which
  // aborts the app. Move straight to the in-call screen instead.
  useEffect(() => {
    return onInviteAccepted(() => {
      if (actedRef.current) return;
      actedRef.current = true;
      router.replace({ pathname: "/call-active", params: { number, name, direction: "incoming" } });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, name]);

  // Auto-answer: connect hands-free shortly after mount, unless the user acts first.
  useEffect(() => {
    if (!isAuto) return;
    const timer = setTimeout(() => {
      if (!actedRef.current) answer();
    }, AUTO_ANSWER_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuto]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <LinearGradient colors={["#26262A", "#0C0C0E"]} style={StyleSheet.absoluteFill} />

      <View style={[styles.header, { paddingTop: insets.top + 60 }]}>
        <Avatar name={displayName || undefined} size={116} />
        <Text style={[type.title1, { color: "#FFFFFF", marginTop: 22 }]} numberOfLines={1}>{title}</Text>
        <Text style={[type.callout, { color: "rgba(235,235,245,0.6)", marginTop: 4 }]}>
          {displayName ? formatPhone(number) : "TCB Phone · Incoming"}
        </Text>
        {isWaiting && (
          <Text style={[type.footnote, { color: "#FFD60A", marginTop: 14, textAlign: "center", paddingHorizontal: 32 }]}>
            Call waiting — answering will end your current call
          </Text>
        )}
      </View>

      <View style={[styles.actions, { paddingBottom: insets.bottom + 28 }]}>
        <View style={styles.secondaryRow}>
          {/* Not during call waiting: dismissing drops back to the live call, and a thread pushed on
              top would cover it. Nor for a withheld caller: there is no number to text. */}
          {!isWaiting && /^\+\d{8,15}$/.test(number) && <SecondaryAction icon="message.fill" fallback="chatbubble" label="Message" onPress={message} />}
        </View>
        <View style={styles.primaryRow}>
          <View style={styles.primaryCol}>
            <Pressable onPress={decline} style={({ pressed }) => [styles.answerBtn, { backgroundColor: "#FF3B30", opacity: pressed ? 0.8 : 1 }]}>
              <Icon name="phone.down.fill" fallback="call" size={34} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.primaryLabel}>Decline</Text>
          </View>
          <View style={styles.primaryCol}>
            <Pressable onPress={answer} style={({ pressed }) => [styles.answerBtn, { backgroundColor: "#34C759", opacity: pressed ? 0.8 : 1 }]}>
              <Icon name="phone.fill" fallback="call" size={34} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.primaryLabel}>Accept</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0C0C0E" },
  header: { alignItems: "center", paddingHorizontal: 24 },
  actions: { marginTop: "auto", paddingHorizontal: 40, gap: 34 },
  secondaryRow: { flexDirection: "row", justifyContent: "center", paddingHorizontal: 20 },
  secondary: { alignItems: "center", gap: 7 },
  secondaryIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" },
  secondaryLabel: { color: "#FFFFFF", fontSize: 12.5 },
  primaryRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 10 },
  primaryCol: { alignItems: "center", gap: 10 },
  answerBtn: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
  primaryLabel: { color: "#FFFFFF", fontSize: 13.5 },
});
