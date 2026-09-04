import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, Linking, Alert } from "react-native";
import * as Updates from "expo-updates";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { Group, Row } from "../../components/ui/Grouped";
import { Segmented } from "../../components/ui/Segmented";
import { BASE_URL, getRecordingSetting, setRecordingSetting, getMe, setPresence } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRegistration, REG_META } from "../../lib/registration";
import { onRegStatus, runConnectionTest } from "../../lib/voice";
import { usePersistedBool, getPref, setPref } from "../../lib/prefs";
import { useUserSettings } from "../../lib/userSettings";
import { useTheme, useThemePreference, type ThemePreference } from "../../theme/theme";
import type { AudioRoutePref } from "../../lib/audioRouting";

// Bumped on every OTA publish so we can confirm on-device that an update actually landed.
const OTA_BUILD = "41";

const AUDIO_ROUTE_LABELS: Record<AudioRoutePref, string> = {
  automatic: "Automatic",
  earpiece: "Earpiece",
  speaker: "Speaker",
  bluetooth: "Bluetooth",
};
const AUDIO_ROUTE_ORDER: AudioRoutePref[] = ["automatic", "earpiece", "speaker", "bluetooth"];

export default function SettingsScreen() {
  const t = useTheme();
  const { user, signOut } = useAuth();
  const { status } = useRegistration();
  const { preference, setPreference } = useThemePreference();
  const { settings, update } = useUserSettings();
  const [voiceReg, setVoiceReg] = useState("…");
  useEffect(() => onRegStatus(setVoiceReg), []);

  // Availability: whether business calls ring this person at all. Read from the server rather than
  // the cached session, so a change made on another device or by an admin shows up here.
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    getMe()
      .then((me) => setAvailable(me.status === "available"))
      .catch(() => {});
  }, []);
  function toggleAvailable(next: boolean) {
    const previous = available;
    setAvailable(next); // optimistic -- this is a toggle people flick while walking to the van
    setPresence(next ? "available" : "away").catch(() => {
      setAvailable(previous);
      Alert.alert("Couldn't save", "Your availability didn't change. Check your connection and try again.");
    });
  }
  const [checking, setChecking] = useState(false);

  // Pull the latest over-the-air (EAS) update on demand, then restart into it. In Expo Go / dev the
  // updates module is disabled, so we say so rather than throwing.
  async function checkForUpdates() {
    if (checking) return;
    if (!Updates.isEnabled) {
      Alert.alert("Updates", "Over-the-air updates aren't available in this build (dev/Expo Go).");
      return;
    }
    setChecking(true);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        await Updates.fetchUpdateAsync();
        Alert.alert("Update ready", "A new version was downloaded. Restart now to apply it?", [
          { text: "Later", style: "cancel" },
          { text: "Restart", onPress: () => Updates.reloadAsync() },
        ]);
      } else {
        Alert.alert("Up to date", `You're on the latest version (#${OTA_BUILD}).`);
      }
    } catch {
      Alert.alert("Update check failed", "Couldn't check for updates just now. Try again on Wi-Fi.");
    } finally {
      setChecking(false);
    }
  }

  // Connection test. "The call sounded bad" is otherwise unfalsifiable: Twilio's Voice Insights
  // reports the CARRIER leg, but the leg that actually degrades is this phone's own connection to
  // Twilio, and nothing measured it. This samples that leg and reports it in plain language.
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);
  async function testConnection() {
    if (testing) return;
    setTesting(true);
    try {
      const r = await runConnectionTest();
      // MOS is the standard 1.0-4.5 perceived-quality score; below ~3.5 is where callers start
      // complaining, which is the threshold worth telling a non-technical user about.
      const poor = (r.mos != null && r.mos < 3.5) || r.warnings.length > 0;
      const headline = r.quality ? r.quality[0].toUpperCase() + r.quality.slice(1) : "Done";
      setLastTest(r.quality ?? "done");
      const lines = [
        r.mos != null ? `Call quality score: ${r.mos} out of 4.5` : null,
        r.jitterMs != null ? `Jitter: ${r.jitterMs} ms` : null,
        r.rttMs != null ? `Round trip: ${r.rttMs} ms` : null,
        r.edge ? `Connected via: ${r.edge}` : null,
        r.warnings.length ? `Warnings: ${r.warnings.join(", ")}` : null,
        "",
        poor
          ? "This connection is likely to cause choppy or robotic audio. Try Wi-Fi, or move somewhere with better signal, before making calls."
          : "This connection looks fine for calls.",
      ].filter((l) => l !== null);
      Alert.alert(`Connection: ${headline}`, lines.join("\n"));
    } catch (e) {
      setLastTest(null);
      Alert.alert(
        "Test failed",
        `Couldn't complete the connection test. ${e instanceof Error ? e.message : ""}`.trim()
      );
    } finally {
      setTesting(false);
    }
  }

  // Preferences persist across launches (SecureStore). The calling ones apply once the
  // native calling layer reads them; theme applies immediately.
  const [callWaiting, setCallWaiting] = usePersistedBool("pref_call_waiting", true);
  const [autoAnswer, setAutoAnswer] = usePersistedBool("pref_auto_answer", false);
  const [bluetooth, setBluetooth] = usePersistedBool("pref_bluetooth", true);

  // Default audio route applied on the next call (audio devices are only live during a call,
  // so this is a preference, not a live control). Persisted the same way voice.ts reads it.
  const [audioRoute, setAudioRouteState] = useState<AudioRoutePref>("automatic");
  useEffect(() => {
    getPref("pref_audio_route", "automatic").then((v) => setAudioRouteState(v as AudioRoutePref)).catch(() => {});
  }, []);
  function cycleAudioRoute() {
    const next = AUDIO_ROUTE_ORDER[(AUDIO_ROUTE_ORDER.indexOf(audioRoute) + 1) % AUDIO_ROUTE_ORDER.length];
    setAudioRouteState(next); // optimistic
    setPref("pref_audio_route", next).catch(() => {});
  }

  // Call Recording is a business-wide setting stored server-side (not a device preference).
  // Admins can toggle it; staff see it read-only.
  const isAdmin = user?.role === "admin";
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    getRecordingSetting().then(setRecording).catch(() => {});
  }, []);
  function onToggleRecording(v: boolean) {
    setRecording(v); // optimistic
    setRecordingSetting(v).catch(() => {});
  }

  return (
    <Screen>
      <LargeHeader title="Settings" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Group
          title="Account"
          footer={
            available === false
              ? "You won't be rung for business calls. This resets to available tomorrow morning, so mark yourself unavailable again if you're still away."
              : "Signed in to the TCB phone system. Turn off Available for Calls if you're off sick or otherwise can't take calls today."
          }
        >
          <Row icon="person.fill" iconColor={t.colors.accent} label="Account" value={user?.email ?? "—"} />
          <Row
            icon="checkmark.circle.fill"
            iconColor={available === false ? t.colors.labelTertiary : "#34C759"}
            label="Available for Calls"
            toggle={available ?? true}
            onToggle={toggleAvailable}
          />
          <Row icon="antenna.radiowaves.left.and.right" iconColor={REG_META[status].tone === "success" ? t.colors.success : t.colors.warning} label="Registration" value={REG_META[status].label} />
          <Row icon="number" iconColor="#8E8E93" label="Role" value={user ? (user.role === "admin" ? "Administrator" : "Staff") : "—"} />
          <Row icon="bell.badge" iconColor={voiceReg.startsWith("registered") ? t.colors.success : t.colors.warning} label="Incoming calls" value={voiceReg} />
        </Group>

        <Group title="Calling" footer="Call Waiting shows a second incoming call while you're on a call. Ring My Mobile sends calls to your mobile instead of this app. Auto-Answer automatically answers incoming calls after a moment. Call Recording is a business-wide setting managed by admins.">
          <Row icon="phone.arrow.up.right.fill" iconColor="#34C759" label="Call Waiting" toggle={callWaiting} onToggle={setCallWaiting} />
          <Row icon="arrow.turn.up.right" iconColor="#0A84FF" label="Ring My Mobile"
            value={settings.ring_my_mobile ? "Diverting" : "Off"} chevron
            onPress={() => router.push("/call-forwarding")} />
          <Row icon="phone.badge.checkmark" iconColor="#5E5CE6" label="Auto-Answer" toggle={autoAnswer} onToggle={setAutoAnswer} />
          {isAdmin ? (
            <Row icon="record.circle" iconColor={t.colors.accent} label="Call Recording" toggle={recording} onToggle={onToggleRecording} />
          ) : (
            <Row icon="record.circle" iconColor={t.colors.accent} label="Call Recording" value={recording ? "On" : "Off"} />
          )}
        </Group>

        <Group title="Audio" footer="Allow routing call audio to Bluetooth devices. Audio Routing sets the default output applied to your next call.">
          <Row icon="headphones" iconColor="#30B0C7" label="Bluetooth" toggle={bluetooth} onToggle={setBluetooth} />
          <Row icon="speaker.wave.2.fill" iconColor="#FF9500" label="Audio Routing" value={AUDIO_ROUTE_LABELS[audioRoute]} onPress={cycleAudioRoute} chevron />
        </Group>

        <Group title="Notifications" footer="Choose which alerts this account receives.">
          <Row icon="phone.fill" iconColor="#34C759" label="Incoming Calls"
            toggle={settings.notif_incoming} onToggle={(v) => update({ notif_incoming: v })} />
          <Row icon="phone.arrow.down.left.fill" iconColor={t.colors.accent} label="Missed Calls"
            toggle={settings.notif_missed} onToggle={(v) => update({ notif_missed: v })} />
          <Row icon="waveform" iconColor="#0A84FF" label="Voicemail"
            toggle={settings.notif_voicemail} onToggle={(v) => update({ notif_voicemail: v })} />
          <Row icon="message.fill" iconColor="#30D158" label="SMS Messages"
            toggle={settings.notif_sms} onToggle={(v) => update({ notif_sms: v })} />
        </Group>

        <Group title="Appearance" footer="Choose Light or Dark, or follow your device's setting.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <Segmented<ThemePreference>
              options={[
                { label: "System", value: "system" },
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ]}
              value={preference}
              onChange={setPreference}
            />
          </View>
        </Group>

        <Group title="About">
          <Row icon="info.circle.fill" iconColor="#8E8E93" label="Version" value="1.0.0" />
          <Row icon="wifi" iconColor="#FF9F0A" label={testing ? "Testing…" : "Test Connection"} value={lastTest ?? undefined} chevron onPress={testConnection} />
          <Row icon="arrow.triangle.2.circlepath" iconColor="#34C759" label={checking ? "Checking…" : "Check for Updates"} value={`#${OTA_BUILD}`} chevron onPress={checkForUpdates} />
          <Row icon="lifepreserver" iconColor="#0A84FF" label="Support" chevron onPress={() => Linking.openURL("mailto:phill@tcbpestcontrolcanberra.com.au")} />
          <Row icon="hand.raised.fill" iconColor="#5E5CE6" label="Privacy Policy" chevron onPress={() => Linking.openURL(`${BASE_URL}/privacy`)} />
          <Row icon="doc.text.fill" iconColor="#8E8E93" label="Terms of Service" chevron onPress={() => Linking.openURL(`${BASE_URL}/terms`)} />
        </Group>

        <Group footer="Preview the incoming-call screen without a live call.">
          <Row icon="bell.badge.fill" iconColor="#FF9500" label="Preview Incoming Call" chevron onPress={() => router.push({ pathname: "/call-incoming", params: { number: "0400123456", name: "" } })} />
        </Group>

        <Group>
          <Row label="Sign Out" destructive onPress={() => signOut()} />
        </Group>

        <View style={{ height: 8 }} />
        <Text style={{ textAlign: "center", color: t.colors.labelTertiary, fontSize: 12 }}>TCB Phone · 1.0.0</Text>
      </ScrollView>
    </Screen>
  );
}
