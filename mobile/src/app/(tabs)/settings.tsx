import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, Linking, Alert } from "react-native";
import * as Updates from "expo-updates";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { Group, Row } from "../../components/ui/Grouped";
import { Segmented } from "../../components/ui/Segmented";
import { BASE_URL, getRecordingSetting, setRecordingSetting } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useRegistration, REG_META } from "../../lib/registration";
import { onRegStatus } from "../../lib/voice";
import { usePersistedBool } from "../../lib/prefs";
import { useUserSettings } from "../../lib/userSettings";
import { useTheme, useThemePreference, type ThemePreference } from "../../theme/theme";

// Bumped on every OTA publish so we can confirm on-device that an update actually landed.
const OTA_BUILD = "22";

export default function SettingsScreen() {
  const t = useTheme();
  const { user, signOut } = useAuth();
  const { status } = useRegistration();
  const { preference, setPreference } = useThemePreference();
  const { settings, update } = useUserSettings();
  const [voiceReg, setVoiceReg] = useState("…");
  useEffect(() => onRegStatus(setVoiceReg), []);
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

  // Preferences persist across launches (SecureStore). The calling ones apply once the
  // native calling layer reads them; theme applies immediately.
  const [callWaiting, setCallWaiting] = usePersistedBool("pref_call_waiting", true);
  const [autoAnswer, setAutoAnswer] = usePersistedBool("pref_auto_answer", false);
  const [bluetooth, setBluetooth] = usePersistedBool("pref_bluetooth", true);

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
        <Group title="Account" footer="Signed in to the TCB phone system.">
          <Row icon="person.fill" iconColor={t.colors.accent} label="Account" value={user?.email ?? "—"} />
          <Row icon="antenna.radiowaves.left.and.right" iconColor={REG_META[status].tone === "success" ? t.colors.success : t.colors.warning} label="Registration" value={REG_META[status].label} />
          <Row icon="number" iconColor="#8E8E93" label="Role" value={user?.role === "admin" ? "Administrator" : "Staff"} />
          <Row icon="bell.badge" iconColor={voiceReg.startsWith("registered") ? t.colors.success : t.colors.warning} label="Incoming calls" value={voiceReg} />
        </Group>

        <Group title="Calling" footer="Applies once native calling is enabled on this device. Call Recording is a business-wide setting managed by admins.">
          <Row icon="phone.arrow.up.right.fill" iconColor="#34C759" label="Call Waiting" toggle={callWaiting} onToggle={setCallWaiting} />
          <Row icon="arrow.turn.up.right" iconColor="#0A84FF" label="Ring My Mobile"
            value={settings.ring_my_mobile ? "On" : "Off"} chevron
            onPress={() => router.push("/call-forwarding")} />
          <Row icon="phone.badge.checkmark" iconColor="#5E5CE6" label="Auto-Answer" toggle={autoAnswer} onToggle={setAutoAnswer} />
          {isAdmin ? (
            <Row icon="record.circle" iconColor={t.colors.accent} label="Call Recording" toggle={recording} onToggle={onToggleRecording} />
          ) : (
            <Row icon="record.circle" iconColor={t.colors.accent} label="Call Recording" value={recording ? "On" : "Off"} />
          )}
        </Group>

        <Group title="Audio">
          <Row icon="headphones" iconColor="#30B0C7" label="Bluetooth" toggle={bluetooth} onToggle={setBluetooth} />
          <Row icon="speaker.wave.2.fill" iconColor="#FF9500" label="Audio Routing" value="Automatic" onPress={() => {}} chevron />
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
