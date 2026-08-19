import React from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { getCalls, type Call } from "../lib/api";
import { colors } from "../lib/theme";

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function CallHistoryScreen() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["calls"], queryFn: getCalls });

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Call history</Text>
        <View style={{ width: 44 }} />
      </View>
      {isLoading ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
      ) : isError && !data ? (
        <Text style={styles.muted}>Couldn&apos;t load calls. Pull to retry.</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c: Call) => c.id}
          onRefresh={refetch}
          refreshing={false}
          ListEmptyComponent={<Text style={styles.muted}>No calls yet.</Text>}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => router.push(`/call/${encodeURIComponent(item.id)}`)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowMain}>
                  {item.direction === "outbound" ? item.called_number : item.caller_number}
                </Text>
                <Text style={styles.rowSub}>
                  {item.direction === "outbound" ? "Outgoing" : "Incoming"} · {fmtWhen(item.started_at)}
                </Text>
              </View>
              {item.recording_sid ? <Text style={styles.rec}>▶ rec</Text> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  back: { color: colors.link, fontSize: 15, width: 44 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  muted: { color: colors.mute, marginTop: 24, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  rowMain: { color: colors.text, fontSize: 15 },
  rowSub: { color: colors.dim, fontSize: 12, marginTop: 2 },
  rec: { color: colors.brand, fontSize: 12, fontWeight: "600" },
});
