import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { router, useLocalSearchParams } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "../components/ui/Icon";
import { Avatar } from "../components/ui/Avatar";
import { formatPhone } from "../lib/phone";
import { haptics } from "../theme/haptics";
import { type } from "../theme/theme";

function SecondaryAction({ icon, fallback, label, onPress }: { icon: SymbolViewProps["name"]; fallback: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondary}>
      <View style={styles.secondaryIcon}>
        <Icon name={icon} fallback={fallback as never} size={26} color="#FFFFFF" />
      </View>
      <Text style={styles.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

export default function IncomingCallScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ number?: string; name?: string }>();
  const number = String(params.number ?? "");
  const name = String(params.name ?? "");
  const title = name || formatPhone(number) || "Unknown";

  function answer() {
    haptics.success();
    router.replace({ pathname: "/call-active", params: { number, name } });
  }
  function decline() {
    haptics.medium();
    router.back();
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <LinearGradient colors={["#26262A", "#0C0C0E"]} style={StyleSheet.absoluteFill} />

      <View style={[styles.header, { paddingTop: insets.top + 60 }]}>
        <Avatar name={name || undefined} size={116} />
        <Text style={[type.title1, { color: "#FFFFFF", marginTop: 22 }]} numberOfLines={1}>{title}</Text>
        <Text style={[type.callout, { color: "rgba(235,235,245,0.6)", marginTop: 4 }]}>
          {name ? formatPhone(number) : "TCB Phone · Incoming"}
        </Text>
      </View>

      <View style={[styles.actions, { paddingBottom: insets.bottom + 28 }]}>
        <View style={styles.secondaryRow}>
          <SecondaryAction icon="alarm.fill" fallback="alarm" label="Remind Me" onPress={decline} />
          <SecondaryAction icon="message.fill" fallback="chatbubble" label="Message" onPress={decline} />
        </View>
        <View style={styles.primaryRow}>
          <View style={styles.primaryCol}>
            <Pressable onPress={decline} style={({ pressed }) => [styles.answerBtn, { backgroundColor: "#FF3B30", opacity: pressed ? 0.8 : 1 }]}>
              <Icon name="phone.down.fill" fallback="call" size={34} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.primaryLabel}>Decline</Text>
          </View>
          <View style={styles.primaryCol}>
            <Pressable onPress={answer} style={({ pressed }) => [styles.answerBtn, { backgroundColor: "#34C759", opacity: pressed ? 0.8 : 1 }]}>
              <Icon name="phone.fill" fallback="call" size={34} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.primaryLabel}>Accept</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0C0C0E" },
  header: { alignItems: "center", paddingHorizontal: 24 },
  actions: { marginTop: "auto", paddingHorizontal: 40, gap: 34 },
  secondaryRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20 },
  secondary: { alignItems: "center", gap: 7 },
  secondaryIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" },
  secondaryLabel: { color: "#FFFFFF", fontSize: 12.5 },
  primaryRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 10 },
  primaryCol: { alignItems: "center", gap: 10 },
  answerBtn: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
  primaryLabel: { color: "#FFFFFF", fontSize: 13.5 },
});
