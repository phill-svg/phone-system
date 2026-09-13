import React, { useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Avatar } from "../components/ui/Avatar";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { getStaffRoster, startTransfer, completeTransfer, type RosterEntry } from "../lib/api";
import { transferTargets } from "../lib/transfer";
import { getActiveCall } from "../lib/voice";
import { useAuth } from "../lib/auth";
import { haptics } from "../theme/haptics";
import { useTheme, type } from "../theme/theme";

// Attended transfer only. A blind transfer the colleague never answers leaves the customer alone in
// the conference, so the staff member stays on the line until the colleague has joined.
export default function TransferScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const roster = useQuery({ queryKey: ["staff-roster"], queryFn: getStaffRoster });
  const [calling, setCalling] = useState<RosterEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const errorMessage = (e: unknown) => (e as { message?: string })?.message ?? "Try again.";

  function ownLeg(): string | null {
    const sid = getActiveCall()?.getSid();
    if (!sid) Alert.alert("No call to transfer", "This call has already ended.");
    return sid ?? null;
  }

  async function callColleague(target: RosterEntry) {
    if (busy) return;
    const sid = ownLeg();
    if (!sid) return;
    haptics.medium();
    setBusy(true);
    try {
      await startTransfer(sid, target.email);
      setCalling(target);
    } catch (e) {
      Alert.alert("Couldn't start the transfer", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (busy) return;
    const sid = ownLeg();
    if (!sid) return;
    setBusy(true);
    try {
      await completeTransfer(sid);
      haptics.medium();
      // The server removed this leg, so the Call disconnects and the in-call screen underneath
      // closes itself once this one is out of the way.
      router.back();
    } catch (e) {
      Alert.alert("Couldn't complete the transfer", errorMessage(e));
      setBusy(false);
    }
  }

  // Cancel only closes this screen. If the colleague is already being rung, their phone keeps ringing
  // (there is no endpoint to withdraw it) and answering joins them to the call as a third party.
  const cancel = () => router.back();

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top }}>
      <View style={styles.bar}>
        <Pressable onPress={cancel} hitSlop={10}><Text style={[type.body, { color: t.colors.accent }]}>Cancel</Text></Pressable>
        <Text style={[type.headline, { color: t.colors.label }]}>Transfer</Text>
        <View style={{ width: 54 }} />
      </View>

      {calling ? (
        <View style={styles.calling}>
          <Avatar name={calling.email} size={84} />
          <Text style={[type.title3, { color: t.colors.label, marginTop: 16, textAlign: "center" }]} numberOfLines={1}>
            Calling {calling.email}…
          </Text>
          <Text style={[type.subhead, { color: t.colors.labelSecondary, marginTop: 8, textAlign: "center", lineHeight: 21 }]}>
            Once they answer, tell them who is on the line, then complete the transfer. The caller can hear you both.
          </Text>
          <View style={{ alignSelf: "stretch", marginTop: 28 }}>
            <PrimaryButton label="Complete transfer" onPress={complete} busy={busy} />
          </View>
        </View>
      ) : (
        <FlatList
          data={transferTargets(roster.data ?? [], user?.email)}
          keyExtractor={(s) => s.email}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6 }}
          ListHeaderComponent={
            <Text style={[type.footnote, { color: t.colors.labelSecondary, marginBottom: 6 }]}>
              Choose a colleague. Their app rings, you speak to them, then complete the transfer.
            </Text>
          }
          ListEmptyComponent={
            roster.isLoading ? (
              <ActivityIndicator style={{ marginTop: 24 }} />
            ) : (
              <Text style={[type.body, { color: t.colors.labelSecondary, marginTop: 24, textAlign: "center" }]}>
                {roster.isError ? errorMessage(roster.error) : "No colleagues to transfer to."}
              </Text>
            )
          }
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 54 }]} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => callColleague(item)}
              disabled={busy}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent", opacity: busy ? 0.5 : 1 }]}
            >
              <Avatar name={item.email} size={42} />
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>{item.email}</Text>
                <Text style={[type.footnote, { color: t.colors.labelSecondary, textTransform: "capitalize" }]}>{item.status}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  calling: { alignItems: "center", paddingHorizontal: 24, paddingTop: 40 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  sep: { height: StyleSheet.hairlineWidth },
});
