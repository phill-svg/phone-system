import React from "react";
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getCallbackRequests, type CallbackRequest } from "../../lib/api";
import { colors } from "../../lib/theme";

// 🎨 COLORS FOR THIS PAGE (Callbacks) — click a swatch to recolor just this screen.
// They start from the shared app theme; change one to override only this page.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // screen background
  surface: "#1b1d24",  // callback rows
  border: "#26282f",   // row borders
  text: "#eceef2",     // main text (number)
  dim: "#a7adb8",      // secondary text (requested time)
  mute: "#6d7280",     // faint "no callbacks" text
  brand: "#e4002b",    // loading spinner
};

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function CallbacksScreen() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["callbacks"], queryFn: getCallbackRequests });

  return (
    <View style={styles.wrap}>
      {isLoading ? (
        <ActivityIndicator color={page.brand} style={{ marginTop: 40 }} />
      ) : isError && !data ? (
        <Text style={styles.muted}>Couldn&apos;t load callbacks. Pull to retry.</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c: CallbackRequest) => String(c.id)}
          onRefresh={refetch}
          refreshing={false}
          ListEmptyComponent={<Text style={styles.muted}>No open callback requests.</Text>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowMain}>{item.caller_number}</Text>
              <Text style={styles.rowSub}>Requested {fmtWhen(item.requested_at)}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: page.bg, padding: 16 },
  muted: { color: page.mute, marginTop: 24, textAlign: "center" },
  row: { backgroundColor: page.surface, borderColor: page.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  rowMain: { color: page.text, fontSize: 15 },
  rowSub: { color: page.dim, fontSize: 12, marginTop: 2 },
});
