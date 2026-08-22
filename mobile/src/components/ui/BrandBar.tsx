import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

// TCB brand header. A solid red bar (matching the web dashboard) carrying the logo and
// "TCB Phone" wordmark, sitting behind the status bar at the very top of each screen.
// Fixed brand red in both light and dark mode — a header is a brand element, not a surface.
const BRAND_RED = "#E4002B";

export function BrandBar({ right }: { right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 10, backgroundColor: BRAND_RED }]}>
      <StatusBar style="light" />
      <Image source={require("../../../assets/images/tcb-logo.png")} style={styles.logo} resizeMode="contain" />
      <Text style={styles.wordmark}>TCB Phone</Text>
      <View style={{ flex: 1 }} />
      {right ?? null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  logo: { width: 30, height: 30, borderRadius: 7, backgroundColor: "#fff" },
  wordmark: { color: "#fff", fontSize: 19, fontWeight: "700", letterSpacing: 0.2 },
});
