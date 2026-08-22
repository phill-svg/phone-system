import React, { useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { Segmented } from "../../components/ui/Segmented";
import { EmptyState } from "../../components/ui/EmptyState";
import { Icon } from "../../components/ui/Icon";
import { getCalls, getContacts, type Call } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

function isMissed(c: Call): boolean {
  return c.direction === "inbound" && /no.?answer|missed|busy|fail|cancel/i.test(c.status);
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
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
              >
                <Icon name={dirIcon} fallback={dirFallback} size={16} color={missed ? t.colors.danger : t.colors.labelSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: missed ? t.colors.danger : t.colors.label, fontWeight: "600" }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>
                    {item.direction === "outbound" ? "Outgoing" : missed ? "Missed" : "Incoming"} · {formatPhone(number)}
                  </Text>
                </View>
                <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{whenLabel(item.started_at)}</Text>
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
