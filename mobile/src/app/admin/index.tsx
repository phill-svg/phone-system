import React, { useCallback, useState } from "react";
import { ScrollView, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { Group, Row } from "../../components/ui/Grouped";
import {
  getAdminStaff,
  getBusinessHours,
  getCallBlocklist,
  getDivertCallerIdSetting,
  getNumbers,
  getRecordingSetting,
  setDivertCallerIdSetting,
  setRecordingSetting,
} from "../../lib/api";
import { describeSchedule, normalizeSchedule } from "../../lib/schedule";
import { useTheme } from "../../theme/theme";

// The mobile mirror of the web /admin/settings page: the business-wide controls, gated to admins.
// The IVR flow editor and Analytics stay web-only -- a drag-and-drop node graph and dense charts
// are not a phone job -- so this hub links the four surfaces that are.
export default function AdminHomeScreen() {
  const t = useTheme();
  const [hours, setHours] = useState<string>("…");
  const [blocked, setBlocked] = useState<string>("…");
  const [staffCount, setStaffCount] = useState<string>("…");
  const [numberCount, setNumberCount] = useState<string>("…");
  const [recording, setRecording] = useState<boolean | null>(null);
  const [divertCallerId, setDivertCallerId] = useState<boolean | null>(null);

  // Refetch on focus so the summaries are right after editing one of the sub-screens.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getBusinessHours()
        .then((s) => alive && setHours(describeSchedule(normalizeSchedule(s))))
        .catch(() => alive && setHours("—"));
      getCallBlocklist()
        .then((n) => alive && setBlocked(n.length === 0 ? "None" : `${n.length} blocked`))
        .catch(() => alive && setBlocked("—"));
      getAdminStaff()
        .then((s) => alive && setStaffCount(`${s.length}`))
        .catch(() => alive && setStaffCount("—"));
      getNumbers()
        .then((n) => alive && setNumberCount(`${n.length}`))
        .catch(() => alive && setNumberCount("—"));
      getRecordingSetting()
        .then((v) => alive && setRecording(v))
        .catch(() => {});
      getDivertCallerIdSetting()
        .then((v) => alive && setDivertCallerId(v))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [])
  );

  function onToggleRecording(next: boolean) {
    const previous = recording;
    setRecording(next); // optimistic
    setRecordingSetting(next).catch(() => {
      setRecording(previous);
      Alert.alert("Couldn't save", "Call recording didn't change. Check your connection and try again.");
    });
  }

  function onToggleDivertCallerId(next: boolean) {
    const previous = divertCallerId;
    setDivertCallerId(next); // optimistic
    setDivertCallerIdSetting(next).catch(() => {
      setDivertCallerId(previous);
      Alert.alert("Couldn't save", "The divert caller ID didn't change. Check your connection and try again.");
    });
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group title="Business" footer="These settings apply to the whole business, not just this phone.">
          <Row icon="clock.fill" iconColor="#0A84FF" label="Business Hours" value={hours} chevron
            onPress={() => router.push("/admin/business-hours")} />
          <Row icon="hand.raised.fill" iconColor={t.colors.accent} label="Call Blocklist" value={blocked} chevron
            onPress={() => router.push("/admin/blocklist")} />
          <Row icon="phone.fill" iconColor="#34C759" label="Phone Numbers" value={numberCount} chevron
            onPress={() => router.push("/admin/numbers")} />
          <Row icon="record.circle" iconColor="#FF9F0A" label="Call Recording"
            toggle={recording ?? false} onToggle={onToggleRecording} toggleDisabled={recording === null} />
        </Group>

        <Group
          title="Diverted calls"
          footer={
            "Applies to every staff member, not just this phone. When a call is diverted to a staff member's mobile, " +
            "show the customer's number so they know who it is before answering — a saved customer rings by name. They " +
            "hear a short \u201cTCB call\u201d on pickup so a work call is never mistaken for a personal one. Off rings " +
            "from the business number instead.\n\nWith this on, a MISSED divert looks like an ordinary unknown number in " +
            "the phone's own call log, and calling it back from there dials the customer from that staff member's " +
            "personal number. Recents here stays the reliable list, and calling back from the app uses the business number."
          }
        >
          <Row icon="person.crop.circle.badge.questionmark" iconColor="#0A84FF" label="Show the customer's number"
            toggle={divertCallerId ?? false} onToggle={onToggleDivertCallerId} />
        </Group>

        <Group title="Team" footer="Working hours, ring order, availability and account access for each staff member.">
          <Row icon="person.2.fill" iconColor="#5E5CE6" label="Staff" value={staffCount} chevron
            onPress={() => router.push("/admin/staff")} />
        </Group>

        <Group title="Diagnostics" footer="Whether Twilio, ServiceM8, email and push are actually working right now — and a test notification you can send to your own phone.">
          <Row icon="stethoscope" iconColor="#FF375F" label="Health Checks" chevron
            onPress={() => router.push("/admin/diagnostics")} />
        </Group>

        <Group footer="The IVR phone menu and the analytics dashboard are still web-only — open tcbvoip.app on a computer for those.">
          <Row icon="info.circle.fill" iconColor="#8E8E93" label="Not on mobile" value="IVR · Analytics" />
        </Group>
      </ScrollView>
    </Screen>
  );
}
