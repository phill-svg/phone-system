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
  getIvrFlow,
  getNumbers,
  getOnCall,
  getRecordingSetting,
  setDivertCallerIdSetting,
  setRecordingSetting,
} from "../../lib/api";
import { describeSchedule, normalizeSchedule } from "../../lib/schedule";
import { shortName } from "../../lib/onCall";
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
  const [onCall, setOnCall] = useState<string>("…");
  const [menuSteps, setMenuSteps] = useState<string>("…");

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
      // The summary answers the only question that matters at a glance -- is tonight covered -- so
      // it names this week's person rather than counting the rotation.
      getOnCall()
        .then((s) => {
          if (!alive) return;
          const now = s.weeks[0];
          setOnCall(now && now.email ? shortName(now.email) : "Nobody");
        })
        .catch(() => alive && setOnCall("—"));
      getIvrFlow("main")
        .then((f) => alive && setMenuSteps(`${f.nodes.length} steps`))
        .catch(() => alive && setMenuSteps("—"));
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
          <Row icon="clock.fill" iconFallback="time" iconColor="#0A84FF" label="Business Hours" value={hours} chevron
            onPress={() => router.push("/admin/business-hours")} />
          <Row icon="hand.raised.fill" iconFallback="hand-left" iconColor={t.colors.accent} label="Call Blocklist" value={blocked} chevron
            onPress={() => router.push("/admin/blocklist")} />
          <Row icon="phone.fill" iconFallback="call" iconColor="#34C759" label="Phone Numbers" value={numberCount} chevron
            onPress={() => router.push("/admin/numbers")} />
          <Row icon="list.bullet.indent" iconFallback="git-branch" iconColor="#FF9F0A" label="Phone Menu" value={menuSteps} chevron
            onPress={() => router.push("/admin/ivr")} />
          <Row icon="record.circle" iconFallback="radio-button-on" iconColor="#FF9F0A" label="Call Recording"
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
          <Row icon="person.crop.circle.badge.questionmark" iconFallback="help-circle" iconColor="#0A84FF" label="Show the customer's number"
            toggle={divertCallerId ?? false} onToggle={onToggleDivertCallerId} toggleDisabled={divertCallerId === null} />
        </Group>

        <Group title="Team" footer="Working hours, ring order, availability and account access for each staff member.">
          <Row icon="person.2.fill" iconFallback="people" iconColor="#5E5CE6" label="Staff" value={staffCount} chevron
            onPress={() => router.push("/admin/staff")} />
          <Row icon="moon.fill" iconFallback="moon" iconColor="#5856D6" label="After-hours On Call" value={onCall} chevron
            onPress={() => router.push("/admin/on-call")} />
        </Group>

        <Group title="Diagnostics" footer="Whether Twilio, ServiceM8, email and push are actually working right now — and a test notification you can send to your own phone.">
          <Row icon="stethoscope" iconFallback="medkit" iconColor="#FF375F" label="Health Checks" chevron
            onPress={() => router.push("/admin/diagnostics")} />
        </Group>

        <Group footer="The analytics dashboard is still web-only — open tcbvoip.app on a computer for that. The web IVR editor also draws the menu as a diagram, which is easier for a big rearrangement.">
          <Row icon="info.circle.fill" iconFallback="information-circle" iconColor="#8E8E93" label="Not on mobile" value="Analytics" />
        </Group>
      </ScrollView>
    </Screen>
  );
}
