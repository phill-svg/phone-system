import React, { useMemo } from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { EmptyState } from "../../components/ui/EmptyState";
import { Avatar } from "../../components/ui/Avatar";
import { Icon } from "../../components/ui/Icon";
import { getCalls, getContacts, type Call } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

// Voicemails are inbound calls that left a transcription — the backend has no
// separate voicemail store, so we derive the inbox from call records.
export default function VoicemailScreen() {
  const t = useTheme();
  const calls = useQuery({ queryKey: ["calls"], queryFn: getCalls });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });

  const voicemails = useMemo(
    () => (calls.data ?? []).filter((c) => c.transcription && c.transcription.trim().length > 0),
    [calls.data]
  );

  function title(c: Call): string {
    const contact = contactForNumber(c.caller_number, contacts.data ?? []);
    return contact?.name ?? formatPhone(c.caller_number) ?? "Unknown";
  }

  return (
    <Screen edges={["top"]}>
      <LargeHeader title="Voicemail" right={<StatusPill />} />
      {calls.isLoading ? (
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />
      ) : calls.isError ? (
        <EmptyState icon="wifi.exclamationmark" title="Couldn't load voicemail" message="Check your connection and try again." tone="danger" />
      ) : voicemails.length === 0 ? (
        <EmptyState icon="waveform" title="No Voicemails" message="Your voicemail inbox is empty." />
      ) : (
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
                <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={2}>{item.transcription}</Text>
                <Text style={[type.caption, { color: t.colors.labelTertiary, marginTop: 2 }]}>
                  {new Date(item.started_at).toLocaleDateString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
              <Icon name="play.circle.fill" fallback="play-circle" size={30} color={t.colors.accent} />
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 11 },
  sep: { height: StyleSheet.hairlineWidth },
});
