import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, View, Text, ActivityIndicator, Alert } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group, Row } from "../../../components/ui/Grouped";
import { PrimaryButton } from "../../../components/ui/PrimaryButton";
import { Segmented } from "../../../components/ui/Segmented";
import { ScheduleEditor } from "../../../components/ui/ScheduleEditor";
import { NumberField } from "../../../components/ui/NumberField";
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
  const [priority, setPriority] = useState(0);
  const [savingPriority, setSavingPriority] = useState(false);
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
      setPriority(found.ringPriority);
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

  // A draft committed on change and saved by its own button, like working hours. It used to save on
  // BLUR: clearing the box and dismissing the keyboard saved `Number("")`, i.e. 0, moving this person
  // to the front of the ring order, and under keyboardShouldPersistTaps="handled" a tap elsewhere
  // never blurred the field, so a typed value could go unsaved with nothing saying so. The server
  // still enforces 0-9999 and its message is shown.
  const priorityDirty = member !== null && priority !== member.ringPriority;

  async function savePriority() {
    if (savingPriority || !member) return;
    setSavingPriority(true);
    try {
      await setStaffRingPriority(member.email, priority);
      setMember({ ...member, ringPriority: priority });
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSavingPriority(false);
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
          {/* min 0: zero is a legitimate priority, it just has to be typed rather than cleared into. */}
          <NumberField label="Priority" placeholder="0" min={0} value={priority} onCommit={setPriority} />
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={savingPriority ? "Saving…" : priorityDirty ? "Save Ring Order" : "Saved"}
            onPress={savePriority}
            disabled={!priorityDirty}
            busy={savingPriority}
          />
        </View>

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
