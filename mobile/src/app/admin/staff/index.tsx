import React, { useCallback, useState } from "react";
import { ScrollView, View, Text, TextInput, ActivityIndicator, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group, Row } from "../../../components/ui/Grouped";
import { PrimaryButton } from "../../../components/ui/PrimaryButton";
import { Segmented } from "../../../components/ui/Segmented";
import { getAdminStaff, inviteStaff, type AdminStaff } from "../../../lib/api";
import { describeSchedule } from "../../../lib/schedule";
import { useTheme, type } from "../../../theme/theme";

// The team, in ring order. Priority decides who hears an inbound call first under the cascade, so
// showing the list sorted that way makes the ordering visible without opening anyone.
export default function StaffListScreen() {
  const t = useTheme();
  const [staff, setStaff] = useState<AdminStaff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    getAdminStaff()
      .then(setStaff)
      .catch(() => setError("Couldn't load the staff list."));
  }, []);
  useFocusEffect(load);

  async function invite() {
    const address = email.trim().toLowerCase();
    if (!address || inviting) return;
    setInviting(true);
    try {
      await inviteStaff(address, role);
      setEmail("");
      Alert.alert("Invite sent", `${address} has been emailed a link to set their password.`);
      load();
    } catch (e) {
      Alert.alert("Couldn't invite", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setInviting(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (staff === null) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  const ordered = [...staff].sort((a, b) => a.ringPriority - b.ringPriority || a.email.localeCompare(b.email));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Group title="Ring order" footer="Lowest number rings first. Tap someone to set their working hours, ring order, availability or account access.">
          {ordered.map((s) => (
            <Row
              key={s.email}
              icon={s.role === "admin" ? "person.badge.key.fill" : "person.fill"}
              iconColor={s.status === "available" ? "#34C759" : t.colors.labelTertiary}
              label={s.email}
              value={`#${s.ringPriority}`}
              chevron
              onPress={() => router.push({ pathname: "/admin/staff/[email]", params: { email: s.email } })}
            />
          ))}
        </Group>

        <Group title="Hours at a glance">
          {ordered.map((s) => (
            <Row key={s.email} label={s.email.split("@")[0]} value={describeSchedule(s.schedule)} />
          ))}
        </Group>

        <Group title="Invite someone" footer="They get an email with a link to set their own password. Admins can change these settings; staff cannot.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 12 }}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="name@example.com"
              placeholderTextColor={t.colors.labelTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
            <Segmented<"staff" | "admin">
              options={[
                { label: "Staff", value: "staff" },
                { label: "Admin", value: "admin" },
              ]}
              value={role}
              onChange={setRole}
            />
          </View>
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={inviting ? "Sending…" : "Send Invite"}
            onPress={invite}
            disabled={email.trim().length === 0}
            busy={inviting}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
