import React, { useCallback, useState } from "react";
import { ScrollView, View, Text, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { Group, Row } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { getDiagnostics, sendTestPush, sendTestEmail, type Check, type CheckStatus } from "../../lib/api";
import { useTheme, type } from "../../theme/theme";

const STATUS_ICON: Record<CheckStatus, { name: Parameters<typeof Row>[0]["icon"]; fallbackColor: string }> = {
  ok: { name: "checkmark.circle.fill", fallbackColor: "#34C759" },
  warn: { name: "exclamationmark.triangle.fill", fallbackColor: "#FF9F0A" },
  fail: { name: "xmark.octagon.fill", fallbackColor: "#FF3B30" },
};

// "Is it actually working?" for the parts of this system that fail silently. Everything here is
// read-only except the two test buttons, which only ever touch the admin's own account.
export default function DiagnosticsScreen() {
  const t = useTheme();
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getDiagnostics()
      .then(setChecks)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't run the checks."));
  }, []);
  useFocusEffect(load);

  async function testPush() {
    if (busy) return;
    setBusy("push");
    try {
      const r = await sendTestPush();
      Alert.alert(
        "Test sent",
        `Sent to ${r.sent} of ${r.devices} device(s).${r.pruned > 0 ? ` ${r.pruned} dead device(s) removed.` : ""}\n\nIf nothing arrives, notifications are off for TCB Phone in your phone's settings.`
      );
      load(); // the device count may have changed if dead tokens were pruned
    } catch (e) {
      Alert.alert("Push failed", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  async function testEmail() {
    if (busy) return;
    setBusy("email");
    try {
      const r = await sendTestEmail();
      Alert.alert("Test sent", `Emailed ${r.to}. If it arrives, staff invites and password resets will send too.`);
    } catch (e) {
      Alert.alert("Email failed", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <Screen>
        <View style={{ padding: 16, gap: 16 }}>
          <Text style={[type.body, { color: t.colors.labelSecondary }]}>{error}</Text>
          <PrimaryButton label="Try Again" onPress={load} />
        </View>
      </Screen>
    );
  }
  if (checks === null) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
        <Text style={[type.footnote, { color: t.colors.labelTertiary, textAlign: "center", marginTop: 12 }]}>
          Checking Twilio, ServiceM8 and your devices…
        </Text>
      </Screen>
    );
  }

  const failing = checks.filter((c) => c.status === "fail").length;
  const warning = checks.filter((c) => c.status === "warn").length;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group
          footer={
            failing > 0
              ? `${failing} check${failing === 1 ? "" : "s"} failing. Tap one to read what to do about it.`
              : warning > 0
                ? `Everything essential is working. ${warning} thing${warning === 1 ? "" : "s"} worth a look.`
                : "Everything is working."
          }
        >
          {checks.map((check) => (
            <Row
              key={check.key}
              icon={STATUS_ICON[check.status].name}
              iconColor={STATUS_ICON[check.status].fallbackColor}
              label={check.label}
              onPress={() => Alert.alert(check.label, check.detail)}
              chevron
            />
          ))}
        </Group>

        {checks.map((check) =>
          check.status === "ok" ? null : (
            <Group key={`${check.key}-detail`} title={check.label}>
              <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={[type.footnote, { color: t.colors.labelSecondary, lineHeight: 18 }]}>{check.detail}</Text>
              </View>
            </Group>
          )
        )}

        <Group
          title="End-to-end tests"
          footer="These actually send something, to your own account only — the rest of the team is never paged by a test."
        >
          <Row
            icon="bell.badge.fill"
            iconColor="#FF9500"
            label={busy === "push" ? "Sending…" : "Send Test Notification"}
            chevron
            onPress={testPush}
          />
          <Row
            icon="envelope.fill"
            iconColor="#0A84FF"
            label={busy === "email" ? "Sending…" : "Send Test Email"}
            chevron
            onPress={testEmail}
          />
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton label="Run Checks Again" onPress={load} />
        </View>
      </ScrollView>
    </Screen>
  );
}
