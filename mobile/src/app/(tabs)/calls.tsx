import React from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { getCalls, type Call } from "../../lib/api";
import { colors } from "../../lib/theme";

// 🎨 COLORS FOR THIS PAGE (History) — click a swatch to recolor just this screen.
// They start from the shared app theme; change one to override only this page.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // screen background
  surface: "#1b1d24",  // call rows
  border: "#26282f",   // row borders
  text: "#eceef2",     // main text (number)
  dim: "#a7adb8",      // secondary text (direction · time)
  mute: "#6d7280",     // faint "no calls" text
  brand: "#e4002b",    // "▶ rec" mark + loading spinner
};

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function CallHistoryScreen() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["calls"], queryFn: getCalls });

  return (
    <View style={styles.wrap}>
      {isLoading ? (
        <ActivityIndicator color={page.brand} style={{ marginTop: 40 }} />
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
  wrap: { flex: 1, backgroundColor: page.bg, padding: 16 },
  muted: { color: page.mute, marginTop: 24, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: page.surface, borderColor: page.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  rowMain: { color: page.text, fontSize: 15 },
  rowSub: { color: page.dim, fontSize: 12, marginTop: 2 },
  rec: { color: page.brand, fontSize: 12, fontWeight: "600" },
});
