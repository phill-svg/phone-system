import React, { useState } from "react";
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getLiveCalls, type LiveCall } from "../../lib/api";
import { colors } from "../../lib/theme";

// 🎨 COLORS FOR THIS PAGE (Live) — click a swatch to recolor just this screen.
// They start from the shared app theme; change one to override only this page.
const page = {
  ...colors,           // shared app theme (fallback for anything not overridden)
  bg: "#0f1013",       // screen background
  surface: "#1b1d24",  // call cards
  border: "#26282f",   // card borders
  text: "#eceef2",     // main text (numbers)
  dim: "#a7adb8",      // secondary text (status)
  mute: "#6d7280",     // faint "no calls" text
  brand: "#e4002b",    // loading spinner
};

export default function LiveCallsScreen() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["live-calls"],
    queryFn: getLiveCalls,
    refetchInterval: 5000,
  });

  const [refreshing, setRefreshing] = useState(false);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.wrap}>
      {isLoading ? (
        <ActivityIndicator color={page.brand} style={{ marginTop: 40 }} />
      ) : isError && !data ? (
        <Text style={styles.muted}>Couldn't load live calls. Pull to retry.</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c: LiveCall) => c.id}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListEmptyComponent={<Text style={styles.muted}>No calls in progress.</Text>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowMain}>{item.caller_number} → {item.called_number}</Text>
              <Text style={styles.rowSub}>{item.status}</Text>
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
