import React from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getLiveCalls, type LiveCall } from "../lib/api";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

export default function LiveCallsScreen() {
  const { signOut } = useAuth();
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["live-calls"],
    queryFn: getLiveCalls,
    refetchInterval: 5000,
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>In progress</Text>
        <Pressable onPress={() => signOut()}><Text style={styles.signout}>Sign out</Text></Pressable>
      </View>
      {isLoading ? (
        <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
      ) : isError ? (
        <Text style={styles.muted}>Couldn't load live calls. Pull to retry.</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(c: LiveCall) => c.id}
          refreshing={isRefetching}
          onRefresh={refetch}
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
  wrap: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  signout: { color: colors.link, fontSize: 14 },
  muted: { color: colors.mute, marginTop: 24, textAlign: "center" },
  row: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  rowMain: { color: colors.text, fontSize: 15 },
  rowSub: { color: colors.dim, fontSize: 12, marginTop: 2 },
});
