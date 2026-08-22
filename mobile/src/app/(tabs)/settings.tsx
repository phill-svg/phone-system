import React from "react";
import { ScrollView, View, Text, Linking } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { Group, Row } from "../../components/ui/Grouped";
import { Segmented } from "../../components/ui/Segmented";
import { useAuth } from "../../lib/auth";
import { useRegistration, REG_META } from "../../lib/registration";
import { usePersistedBool } from "../../lib/prefs";
import { useTheme, useThemePreference, type ThemePreference } from "../../theme/theme";

// Bumped on every OTA publish so we can confirm on-device that an update actually landed.
const OTA_BUILD = "10";

export default function SettingsScreen() {
  const t = useTheme();
  const { user, signOut } = useAuth();
  const { status } = useRegistration();
  const { preference, setPreference } = useThemePreference();

  // Preferences persist across launches (SecureStore). The calling ones apply once the
  // native calling layer reads them; theme applies immediately.
  const [callWaiting, setCallWaiting] = usePersistedBool("pref_call_waiting", true);
  const [autoAnswer, setAutoAnswer] = usePersistedBool("pref_auto_answer", false);
  const [recording, setRecording] = usePersistedBool("pref_recording", true);
  const [bluetooth, setBluetooth] = usePersistedBool("pref_bluetooth", true);
  const [nIncoming, setNIncoming] = usePersistedBool("pref_notify_incoming", true);
  const [nMissed, setNMissed] = usePersistedBool("pref_notify_missed", true);
  const [nVoicemail, setNVoicemail] = usePersistedBool("pref_notify_voicemail", true);

  return (
    <Screen>
      <LargeHeader title="Settings" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Group title="Account" footer="Signed in to the TCB phone system.">
          <Row icon="person.fill" iconColor={t.colors.accent} label="Account" value={user?.email ?? "—"} />
          <Row icon="antenna.radiowaves.left.and.right" iconColor={REG_META[status].tone === "success" ? t.colors.success : t.colors.warning} label="Registration" value={REG_META[status].label} />
          <Row icon="number" iconColor="#8E8E93" label="Role" value={user?.role === "admin" ? "Administrator" : "Staff"} />
        </Group>

        <Group title="Calling" footer="Applies once native calling is enabled on this device.">
          <Row icon="phone.arrow.up.right.fill" iconColor="#34C759" label="Call Waiting" toggle={callWaiting} onToggle={setCallWaiting} />
          <Row icon="arrow.turn.up.right" iconColor="#0A84FF" label="Call Forwarding" value="Off" onPress={() => {}} chevron />
          <Row icon="phone.badge.checkmark" iconColor="#5E5CE6" label="Auto-Answer" toggle={autoAnswer} onToggle={setAutoAnswer} />
          <Row icon="record.circle" iconColor={t.colors.accent} label="Call Recording" toggle={recording} onToggle={setRecording} />
        </Group>

        <Group title="Audio">
          <Row icon="headphones" iconColor="#30B0C7" label="Bluetooth" toggle={bluetooth} onToggle={setBluetooth} />
          <Row icon="speaker.wave.2.fill" iconColor="#FF9500" label="Audio Routing" value="Automatic" onPress={() => {}} chevron />
        </Group>

        <Group title="Notifications">
          <Row icon="phone.fill" iconColor="#34C759" label="Incoming Calls" toggle={nIncoming} onToggle={setNIncoming} />
          <Row icon="phone.arrow.down.left.fill" iconColor={t.colors.accent} label="Missed Calls" toggle={nMissed} onToggle={setNMissed} />
          <Row icon="waveform" iconColor="#0A84FF" label="Voicemail" toggle={nVoicemail} onToggle={setNVoicemail} />
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
          <Row icon="arrow.triangle.2.circlepath" iconColor="#34C759" label="Update" value={`#${OTA_BUILD}`} />
          <Row icon="lifepreserver" iconColor="#0A84FF" label="Support" chevron onPress={() => Linking.openURL("mailto:phill@tcbpestcontrolcanberra.com.au")} />
          <Row icon="hand.raised.fill" iconColor="#5E5CE6" label="Privacy Policy" chevron onPress={() => {}} />
          <Row icon="doc.text.fill" iconColor="#8E8E93" label="Terms of Service" chevron onPress={() => {}} />
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
