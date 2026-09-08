import React, { useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { Segmented } from "../../components/ui/Segmented";
import { EmptyState } from "../../components/ui/EmptyState";
import { Avatar } from "../../components/ui/Avatar";
import { Icon } from "../../components/ui/Icon";
import {
  getCalls,
  getContacts,
  getNumbers,
  getCallbackRequests,
  setCallbackRequestStatus,
  type Call,
  type CallbackRequest,
} from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { resolveSendingNumber } from "../../lib/sendingNumber";
import { usePersistedString } from "../../lib/prefs";
import { placeCall } from "../../lib/placeCall";
import { useUserSettings } from "../../lib/userSettings";
import { haptics } from "../../theme/haptics";
import { useTheme, type } from "../../theme/theme";

function whenLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Voicemails are inbound calls that left a transcription — the backend has no
// separate voicemail store, so we derive the inbox from call records.
function VoicemailList() {
  const t = useTheme();
  const calls = useQuery({ queryKey: ["calls"], queryFn: getCalls });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });

  // A voicemail is a call that landed in a mailbox -- NOT one that happens to have a transcript.
  // Filtering on the transcript hid every message Whisper produced nothing for, which is most short
  // ones: a caller who says "it's Dave, call me" in four seconds often transcribes to silence, and
  // those were exactly the messages that vanished. The recording was always there to play.
  const voicemails = useMemo(
    () => (calls.data ?? []).filter((c) => c.mailbox_label !== null && c.mailbox_label.trim() !== ""),
    [calls.data]
  );

  function title(c: Call): string {
    const contact = contactForNumber(c.caller_number, contacts.data ?? []);
    return contact?.name ?? formatPhone(c.caller_number) ?? "Unknown";
  }

  if (calls.isLoading) return <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />;
  if (calls.isError) {
    return <EmptyState icon="wifi.exclamationmark" title="Couldn't load voicemail" message="Check your connection and try again." tone="danger" />;
  }
  if (voicemails.length === 0) {
    return <EmptyState icon="waveform" title="No Voicemails" message="Your voicemail inbox is empty." />;
  }

  return (
    <FlatList
      data={voicemails}
      keyExtractor={(c) => c.id}
      onRefresh={calls.refetch}
      refreshing={calls.isFetching && !calls.isLoading}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4 }}
      ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 54 }]} />}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(`/call/${encodeURIComponent(item.id)}`)}
          style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
        >
          <Avatar name={contactForNumber(item.caller_number, contacts.data ?? [])?.name} size={42} />
          <View style={{ flex: 1 }}>
            <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>{title(item)}</Text>
            <Text
              style={[type.footnote, { color: item.transcription ? t.colors.labelSecondary : t.colors.labelTertiary }]}
              numberOfLines={2}
            >
              {item.transcription ?? "No transcript \u2014 tap to play the message."}
            </Text>
            <Text style={[type.caption, { color: t.colors.labelTertiary, marginTop: 2 }]}>
              {whenLabel(item.started_at)}
            </Text>
          </View>
          <Icon name="play.circle.fill" fallback="play-circle" size={30} color={t.colors.accent} />
        </Pressable>
      )}
    />
  );
}

type CallbackRow =
  | { kind: "header"; label: string }
  | { kind: "row"; request: CallbackRequest };

// Callers who asked to be rung back (the IVR's callback node). Open requests are the work queue;
// handled ones stay below as history, so "did anyone actually ring them?" stays answerable.
function CallbackList() {
  const { settings } = useUserSettings();
  const t = useTheme();
  const qc = useQueryClient();
  const requests = useQuery({ queryKey: ["callback-requests"], queryFn: getCallbackRequests });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });
  const { data: numbers } = useQuery({ queryKey: ["numbers"], queryFn: getNumbers, staleTime: 300_000 });

  // Same caller-ID resolution and remembered choice as the keypad, so ringing someone back from
  // here shows them the number they would have seen from any other outbound call.
  const voiceNums = (numbers ?? []).filter((n) => n.voice_enabled);
  const [fromNum] = usePersistedString("pref_from_voice", (v) => voiceNums.some((n) => n.e164 === v));
  const effectiveFrom = resolveSendingNumber(voiceNums, fromNum, (n) => !!n.is_default_voice);

  const open = useMemo(() => (requests.data ?? []).filter((r) => r.status === "open"), [requests.data]);
  const done = useMemo(() => (requests.data ?? []).filter((r) => r.status === "done"), [requests.data]);

  function name(r: CallbackRequest): string {
    const contact = contactForNumber(r.caller_number, contacts.data ?? []);
    return contact?.name ?? formatPhone(r.caller_number) ?? "Unknown";
  }

  function callBack(r: CallbackRequest) {
    haptics.medium();
    placeCall({ number: r.caller_number, name: name(r), from: effectiveFrom ?? undefined, settings });
  }

  async function toggle(r: CallbackRequest) {
    haptics.success();
    try {
      await setCallbackRequestStatus(r.id, r.status === "open" ? "done" : "open");
    } finally {
      // Refetch either way: on success to move the row between sections, on failure to fall back
      // to whatever the server actually holds rather than leaving a wrong tick on screen.
      await qc.invalidateQueries({ queryKey: ["callback-requests"] });
    }
  }

  if (requests.isLoading) return <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />;
  if (requests.isError) {
    return <EmptyState icon="wifi.exclamationmark" title="Couldn't load callbacks" message="Check your connection and try again." tone="danger" />;
  }
  if (open.length === 0 && done.length === 0) {
    return <EmptyState icon="phone.arrow.up.right" title="No Callbacks" message="Callers who ask to be rung back will appear here." />;
  }

  // One list with two labelled sections, so a completed request is one scroll away rather than
  // behind another mode switch.
  const rows: CallbackRow[] = [
    ...(open.length ? [{ kind: "header" as const, label: `OPEN (${open.length})` }] : []),
    ...open.map((request) => ({ kind: "row" as const, request })),
    ...(done.length ? [{ kind: "header" as const, label: "COMPLETED" }] : []),
    ...done.map((request) => ({ kind: "row" as const, request })),
  ];

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => (r.kind === "header" ? `h:${r.label}` : `r:${r.request.id}`)}
      onRefresh={requests.refetch}
      refreshing={requests.isFetching && !requests.isLoading}
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4 }}
      renderItem={({ item }) => {
        if (item.kind === "header") {
          return (
            <Text style={[type.caption, styles.sectionHeader, { color: t.colors.labelTertiary }]}>
              {item.label}
            </Text>
          );
        }
        const r = item.request;
        const isDone = r.status === "done";
        return (
          <View style={[styles.row, { opacity: isDone ? 0.55 : 1 }]}>
            <Avatar name={contactForNumber(r.caller_number, contacts.data ?? [])?.name} size={42} />
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>
                {name(r)}
              </Text>
              <Text style={[type.caption, { color: t.colors.labelTertiary, marginTop: 2 }]} numberOfLines={1}>
                {isDone && r.done_at
                  ? `Called back by ${r.done_by ?? "someone"} · ${whenLabel(r.done_at)}`
                  : `Requested ${whenLabel(r.requested_at)}`}
              </Text>
            </View>
            {!isDone && (
              <Pressable onPress={() => callBack(r)} hitSlop={8} style={styles.action}>
                <Icon name="phone.fill" fallback="call" size={22} color={t.colors.accent} />
              </Pressable>
            )}
            <Pressable onPress={() => toggle(r)} hitSlop={8} style={styles.action}>
              <Icon
                name={isDone ? "checkmark.circle.fill" : "checkmark.circle"}
                fallback={isDone ? "checkmark-circle" : "checkmark-circle-outline"}
                size={26}
                color={isDone ? t.colors.labelTertiary : t.colors.accent}
              />
            </Pressable>
          </View>
        );
      }}
    />
  );
}

export default function InboxScreen() {
  const [tab, setTab] = useState<"voicemail" | "callbacks">("voicemail");
  return (
    <Screen>
      <LargeHeader title="Inbox" right={<StatusPill />} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { label: "Voicemail", value: "voicemail" },
            { label: "Callbacks", value: "callbacks" },
          ]}
        />
      </View>
      {tab === "voicemail" ? <VoicemailList /> : <CallbackList />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 11 },
  sep: { height: StyleSheet.hairlineWidth },
  sectionHeader: { fontWeight: "700", letterSpacing: 0.6, marginTop: 14, marginBottom: 2 },
  action: { paddingHorizontal: 4, paddingTop: 8 },
});
