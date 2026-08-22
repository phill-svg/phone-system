import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { router, useLocalSearchParams } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "../components/ui/Icon";
import { Avatar } from "../components/ui/Avatar";
import { DialPad } from "../components/keypad/DialPad";
import { formatPhone } from "../lib/phone";
import { placeCall, getActiveCall } from "../lib/voice";
import { Call as TwilioCall } from "@twilio/voice-react-native-sdk";
import { haptics } from "../theme/haptics";
import { type } from "../theme/theme";

type CallState = "calling" | "connected" | "ended";

// Colours are fixed for the call screen — like the native phone UI it commits to a
// dark look in both light and dark mode so the controls read the same on a glance.
const C = {
  text: "#FFFFFF",
  sub: "rgba(235,235,245,0.6)",
  ctrl: "rgba(255,255,255,0.14)",
  ctrlActive: "#FFFFFF",
  ctrlActiveIcon: "#111",
  end: "#FF3B30",
  green: "#34C759",
  recording: "#FF453A",
};

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function Control({
  icon,
  fallback,
  label,
  active,
  disabled,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  fallback: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <View style={styles.controlCell}>
      <Pressable
        onPress={() => {
          if (disabled) return;
          haptics.press();
          onPress?.();
        }}
        style={({ pressed }) => [
          styles.control,
          { backgroundColor: active ? C.ctrlActive : C.ctrl, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 },
        ]}
      >
        <Icon name={icon} fallback={fallback as never} size={28} color={active ? C.ctrlActiveIcon : C.text} />
      </Pressable>
      <Text style={styles.controlLabel}>{label}</Text>
    </View>
  );
}

export default function ActiveCallScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ number?: string; name?: string; direction?: string }>();
  const number = String(params.number ?? "");
  const name = String(params.name ?? "");
  const isIncoming = params.direction === "incoming";

  const [state, setState] = useState<CallState>("calling");
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [held, setHeld] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [entered, setEntered] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const callRef = useRef<TwilioCall | null>(null);

  function finish() {
    if (timer.current) clearInterval(timer.current);
    setState("ended");
    setTimeout(() => router.back(), 600);
  }

  // Drive the on-screen state from the real Twilio call — an accepted incoming call (already
  // connecting) for incoming, or a freshly placed outbound call otherwise.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const call = isIncoming ? getActiveCall() : await placeCall(number);
        if (!call) {
          finish();
          return;
        }
        if (!mounted) {
          call.disconnect();
          return;
        }
        callRef.current = call;
        if (isIncoming) setState("connected");
        call.on(TwilioCall.Event.Ringing, () => setState("calling"));
        call.on(TwilioCall.Event.Connected, () => setState("connected"));
        call.on(TwilioCall.Event.Disconnected, () => finish());
        call.on(TwilioCall.Event.ConnectFailure, (e: unknown) => {
          setErrorText((e as { message?: string })?.message ?? "Call failed");
          finish();
        });
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : "Couldn't start the call");
        finish();
      }
    })();
    return () => {
      mounted = false;
      callRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state === "connected" && !held) {
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [state, held]);

  function endCall() {
    haptics.heavy();
    if (callRef.current) callRef.current.disconnect();
    else finish();
  }

  function toggleMute() {
    const next = !muted;
    callRef.current?.mute(next);
    setMuted(next);
  }

  const statusLine =
    state === "calling" ? "Calling…" : state === "ended" ? (errorText ?? "Call Ended") : held ? "On Hold" : fmtDuration(seconds);
  const title = name || formatPhone(number) || "Unknown";

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <LinearGradient colors={["#2A2A2E", "#0E0E10"]} style={StyleSheet.absoluteFill} />

      {/* Callee identity */}
      <View style={[styles.header, { paddingTop: insets.top + 28 }]}>
        {recording ? (
          <View style={styles.recPill}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>REC</Text>
          </View>
        ) : null}
        <Avatar name={name || undefined} size={104} />
        <Text style={[type.title1, { color: C.text, marginTop: 20 }]} numberOfLines={1}>{title}</Text>
        {name ? <Text style={[type.callout, { color: C.sub, marginTop: 2 }]}>{formatPhone(number)}</Text> : null}
        <Text style={[type.body, { color: state === "calling" ? C.sub : C.text, marginTop: 10, fontVariant: ["tabular-nums"] }]}>
          {statusLine}
        </Text>
      </View>

      {/* Controls */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        {showKeypad ? (
          <View style={styles.inlineKeypad}>
            <Text style={[styles.enteredDigits]} numberOfLines={1}>{entered}</Text>
            <DialPad onKey={(c) => setEntered((e) => e + c)} />
            <Pressable onPress={() => setShowKeypad(false)} style={styles.hideKeypad}>
              <Text style={styles.hideKeypadText}>Hide</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.grid}>
            <Control icon="mic.slash.fill" fallback="mic-off" label="mute" active={muted} onPress={toggleMute} />
            <Control icon="circle.grid.3x3.fill" fallback="keypad" label="keypad" disabled={state !== "connected"} onPress={() => setShowKeypad(true)} />
            <Control icon="speaker.wave.2.fill" fallback="volume-high" label="speaker" active={speaker} onPress={() => setSpeaker((s) => !s)} />
            <Control icon="plus" fallback="add" label="add call" disabled={state !== "connected"} onPress={() => router.push("/contacts")} />
            <Control icon="pause.fill" fallback="pause" label="hold" active={held} disabled={state !== "connected"} onPress={() => setHeld((h) => !h)} />
            <Control icon="arrow.uturn.right" fallback="arrow-redo" label="transfer" disabled={state !== "connected"} onPress={() => router.push({ pathname: "/transfer", params: { number, name } })} />
            <Control icon="record.circle" fallback="radio-button-on" label="record" active={recording} disabled={state !== "connected"} onPress={() => setRecording((r) => !r)} />
            <Control icon="person.crop.circle.fill" fallback="person" label="contacts" onPress={() => router.push("/contacts")} />
            <View style={styles.controlCell} />
          </View>
        )}

        {/* End call — separated from the control cluster */}
        <Pressable onPress={endCall} style={({ pressed }) => [styles.endBtn, { backgroundColor: C.end, opacity: pressed ? 0.8 : 1 }]}>
          <Icon name="phone.down.fill" fallback="call" size={34} color="#FFFFFF" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0E0E10" },
  header: { alignItems: "center", paddingHorizontal: 24 },
  recPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,69,58,0.16)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, marginBottom: 16 },
  recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.recording },
  recText: { color: C.recording, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  controls: { marginTop: "auto", paddingHorizontal: 40, alignItems: "center", gap: 26 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 22, width: "100%", maxWidth: 300 },
  controlCell: { width: "33.33%", alignItems: "center", gap: 7 },
  control: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center" },
  controlLabel: { color: C.text, fontSize: 12.5, textTransform: "capitalize" },
  endBtn: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
  inlineKeypad: { width: "100%", alignItems: "center", gap: 16 },
  enteredDigits: { color: C.text, fontSize: 30, fontWeight: "300", height: 40, letterSpacing: 1 },
  hideKeypad: { paddingVertical: 8 },
  hideKeypadText: { color: C.sub, fontSize: 16 },
});
