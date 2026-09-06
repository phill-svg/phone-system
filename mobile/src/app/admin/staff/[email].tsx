import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, ActivityIndicator, Alert } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group, Row } from "../../../components/ui/Grouped";
import { PrimaryButton } from "../../../components/ui/PrimaryButton";
import { Segmented } from "../../../components/ui/Segmented";
import { ScheduleEditor } from "../../../components/ui/ScheduleEditor";
import {
  getAdminStaff,
  setStaffSchedule,
  setStaffRingPriority,
  setStaffAvailability,
  resendStaffInvite,
  sendStaffPasswordReset,
  removeStaff,
  CLOSED_WEEK,
  type AdminStaff,
  type BusinessHours,
} from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { isSameSchedule, normalizeSchedule } from "../../../lib/schedule";
import { useTheme, type } from "../../../theme/theme";

// Route params arrive decoded on every platform we ship, but an email is pushed through the URL
// encoded, so decode defensively rather than looking up "a%40b.com" and finding nobody.
function decodeParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : (raw ?? "");
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function StaffMemberScreen() {
  const t = useTheme();
  const { user } = useAuth();
  const email = decodeParam(useLocalSearchParams<{ email: string }>().email);

  const [member, setMember] = useState<AdminStaff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<BusinessHours>(CLOSED_WEEK);
  const [priority, setPriority] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const found = (await getAdminStaff()).find((s) => s.email.toLowerCase() === email.toLowerCase());
      if (!found) {
        setError("That staff member no longer exists.");
        return;
      }
      setMember(found);
      setSchedule(normalizeSchedule(found.schedule));
      setPriority(String(found.ringPriority));
    } catch {
      setError("Couldn't load this staff member.");
    }
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  const scheduleDirty = member !== null && !isSameSchedule(normalizeSchedule(member.schedule), schedule);

  async function saveSchedule() {
    if (savingSchedule || !member) return;
    setSavingSchedule(true);
    try {
      await setStaffSchedule(member.email, schedule);
      setMember({ ...member, schedule });
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function savePriority() {
    if (!member) return;
    const value = Number(priority.trim());
    if (!Number.isFinite(value) || value < 0 || value > 9999) {
      Alert.alert("Ring order", "Enter a whole number between 0 and 9999. Lower rings earlier.");
      setPriority(String(member.ringPriority));
      return;
    }
    const rounded = Math.round(value);
    if (rounded === member.ringPriority) {
      setPriority(String(rounded));
      return;
    }
    try {
      await setStaffRingPriority(member.email, rounded);
      setMember({ ...member, ringPriority: rounded });
      setPriority(String(rounded));
    } catch (e) {
      setPriority(String(member.ringPriority));
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    }
  }

  async function changeAvailability(next: "available" | "away") {
    if (!member || next === member.status) return;
    const previous = member.status;
    setMember({ ...member, status: next }); // optimistic
    try {
      await setStaffAvailability(member.email, next);
    } catch (e) {
      setMember({ ...member, status: previous });
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    }
  }

  async function runAction(key: string, run: () => Promise<void>, done: string) {
    if (busyAction) return;
    setBusyAction(key);
    try {
      await run();
      Alert.alert("Done", done);
    } catch (e) {
      Alert.alert("Didn't work", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusyAction(null);
    }
  }

  function confirmRemove() {
    if (!member) return;
    Alert.alert(
      "Remove staff member?",
      `${member.email} will be signed out everywhere and won't be rung again. Their call history stays.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            runAction("remove", async () => {
              await removeStaff(member.email);
              router.back();
            }, `${member.email} was removed.`),
        },
      ]
    );
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (!member) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  const isSelf = user?.email.toLowerCase() === member.email.toLowerCase();

  return (
    <Screen>
      <Stack.Screen options={{ title: member.email.split("@")[0] }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Group title="Account">
          <Row icon="person.fill" iconColor={t.colors.accent} label="Email" value={member.email} />
          <Row icon="number" iconColor="#8E8E93" label="Role" value={member.role === "admin" ? "Administrator" : "Staff"} />
          <Row
            icon="key.fill"
            iconColor={member.hasPassword ? "#34C759" : "#FF9F0A"}
            label="Password"
            value={member.hasPassword ? "Set" : "Invited — not set"}
          />
        </Group>

        <Group
          title="Availability"
          footer="Away benches them from the ring cascade for today. The server puts everyone back to available each morning, so this is a one-day override, not a roster change."
        >
          <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <Segmented<"available" | "away">
              options={[
                { label: "Available", value: "available" },
                { label: "Away", value: "away" },
              ]}
              value={member.status === "available" ? "available" : "away"}
              onChange={changeAvailability}
            />
          </View>
        </Group>

        <Group
          title="Ring order"
          footer="Lower rings earlier in the cascade. Each person on shift contributes exactly one leg — their softphone, or their mobile if they've turned on Ring My Mobile."
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>Priority</Text>
            <TextInput
              value={priority}
              onChangeText={setPriority}
              onBlur={savePriority}
              keyboardType="number-pad"
              returnKeyType="done"
              onSubmitEditing={savePriority}
              style={{
                color: t.colors.label,
                backgroundColor: t.colors.fill,
                borderRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: 8,
                fontSize: 17,
                minWidth: 84,
                textAlign: "center",
              }}
            />
          </View>
        </Group>

        <Group
          title="Working hours"
          footer="When this person is on shift. Outside these hours they are not rung, even if they're marked available."
        >
          <ScheduleEditor value={schedule} onChange={setSchedule} disabled={savingSchedule} />
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={savingSchedule ? "Saving…" : scheduleDirty ? "Save Working Hours" : "Saved"}
            onPress={saveSchedule}
            disabled={!scheduleDirty}
            busy={savingSchedule}
          />
        </View>

        <Group title="Access" footer={isSelf ? "You can't remove your own account." : undefined}>
          {member.hasPassword ? (
            <Row
              icon="envelope.fill"
              iconColor="#0A84FF"
              label={busyAction === "reset" ? "Sending…" : "Send Password Reset"}
              chevron
              onPress={() =>
                runAction("reset", () => sendStaffPasswordReset(member.email), `A reset link was emailed to ${member.email}.`)
              }
            />
          ) : (
            <Row
              icon="envelope.badge.fill"
              iconColor="#FF9F0A"
              label={busyAction === "invite" ? "Sending…" : "Resend Invite"}
              chevron
              onPress={() =>
                runAction("invite", () => resendStaffInvite(member.email), `A new invite was emailed to ${member.email}.`)
              }
            />
          )}
          {isSelf ? (
            <Row label="Remove Staff Member" value="Not you" />
          ) : (
            <Row label={busyAction === "remove" ? "Removing…" : "Remove Staff Member"} destructive onPress={confirmRemove} />
          )}
        </Group>
      </ScrollView>
    </Screen>
  );
}
