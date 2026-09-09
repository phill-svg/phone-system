import React, { useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { confirmDelete } from "../../lib/confirmDelete";
import { useAuth } from "../../lib/auth";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { Segmented } from "../../components/ui/Segmented";
import { EmptyState } from "../../components/ui/EmptyState";
import { Icon } from "../../components/ui/Icon";
import { getCalls, getContacts, deleteCall, restoreCall, type Call } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

// A missed call is an inbound one NOBODY PICKED UP -- including the ones that left a voicemail,
// because those are exactly the calls that still need returning.
//
// This used to test `status`, which is Twilio's word for how the phone call ended rather than
// whether a human answered: a caller who rang out to voicemail is `completed`, indistinguishable
// from a real conversation. So most genuinely missed calls rendered in black as "Incoming" and the
// red styling that was already here almost never appeared. The `answered` event is the same signal
// analytics has always used.
//
// `event_count === 0` means there is no timeline for the call at all (rows predating the event
// log), where nothing can be concluded -- those keep the old status heuristic rather than turning
// a whole history red.
export function isMissed(c: Call): boolean {
  if (c.direction !== "inbound") return false;
  if (c.status === "in_progress") return false;
  if (c.event_count === 0) return /no.?answer|missed|busy|fail|cancel/i.test(c.status);
  return c.answered === 0;
}

function whenLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yst = new Date(now); yst.setDate(now.getDate() - 1);
  if (sameDay) return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === yst.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export default function RecentsScreen() {
  const t = useTheme();
  const [filter, setFilter] = useState<"all" | "missed">("all");
  const calls = useQuery({ queryKey: ["calls"], queryFn: getCalls });
  const { user } = useAuth();
  // Deleting hides a record the whole team sees, so it matches the other business-wide controls:
  // admins only. Long-press rather than a swipe -- Recents is scrolled constantly and a stray
  // swipe on a call log should never be able to remove it.
  const isAdmin = user?.role === "admin";
  function removeCall(id: string) {
    confirmDelete({
      title: "Delete this call?",
      message: "It disappears from everyone's call history. The recording stays in Twilio.",
      onDelete: async () => {
        await deleteCall(id);
        return () => restoreCall(id);
      },
      onDone: () => calls.refetch(),
    });
  }

  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });

  const rows = useMemo(() => {
    const list = calls.data ?? [];
    return filter === "missed" ? list.filter(isMissed) : list;
  }, [calls.data, filter]);

  function displayName(c: Call): { title: string; missed: boolean } {
    const number = c.direction === "outbound" ? c.called_number : c.caller_number;
    const contact = contactForNumber(number, contacts.data ?? []);
    return { title: contact?.name ?? formatPhone(number) ?? "Unknown", missed: isMissed(c) };
  }

  return (
    <Screen>
      <LargeHeader title="Recents" right={<StatusPill />} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { label: "All", value: "all" },
            { label: "Missed", value: "missed" },
          ]}
        />
      </View>

      {calls.isLoading ? (
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />
      ) : calls.isError ? (
        <EmptyState icon="wifi.exclamationmark" title="Couldn't load calls" message="Check your connection and pull to refresh." tone="danger" />
      ) : rows.length === 0 ? (
        <EmptyState icon="clock" title="No Recent Calls" message="Your recent calls will appear here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          onRefresh={calls.refetch}
          refreshing={calls.isFetching && !calls.isLoading}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 34 }]} />}
          renderItem={({ item }) => {
            const { title, missed } = displayName(item);
            const number = item.direction === "outbound" ? item.called_number : item.caller_number;
            const dirIcon = missed ? "phone.arrow.down.left" : item.direction === "outbound" ? "arrow.up.right" : "arrow.down.left";
            const dirFallback = missed ? "call" : item.direction === "outbound" ? "arrow-up" : "arrow-down";
            return (
              <Pressable
                onPress={() => router.push(`/call/${encodeURIComponent(item.id)}`)}
                onLongPress={isAdmin ? () => removeCall(item.id) : undefined}
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
              >
                <Icon name={dirIcon} fallback={dirFallback} size={16} color={missed ? t.colors.danger : t.colors.labelSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: missed ? t.colors.danger : t.colors.label, fontWeight: "600" }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>
                    {missed ? (
                      <Text style={{ color: t.colors.danger, fontWeight: "600" }}>Missed</Text>
                    ) : (
                      item.direction === "outbound" ? "Outgoing" : "Incoming"
                    )} · {formatPhone(number)}
                  </Text>
                </View>
                <Text style={[type.footnote, { color: missed ? t.colors.danger : t.colors.labelSecondary }]}>
                  {whenLabel(item.started_at)}
                </Text>
                <Icon name="info.circle" fallback="information-circle-outline" size={20} color={t.colors.accent} />
              </Pressable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingHorizontal: 4 },
  sep: { height: StyleSheet.hairlineWidth },
});
