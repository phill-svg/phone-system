import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTheme, type } from "../../theme/theme";
import { useRegistration, REG_META } from "../../lib/registration";

// Subtle registration indicator for nav headers: a coloured dot + short label.
// Deliberately quiet so it informs without competing with call actions.
export function StatusPill() {
  const t = useTheme();
  const { status } = useRegistration();
  const meta = REG_META[status];
  const dot =
    meta.tone === "success" ? t.colors.success : meta.tone === "danger" ? t.colors.danger : meta.tone === "warning" ? t.colors.warning : t.colors.labelTertiary;
  return (
    <View style={[styles.wrap, { backgroundColor: t.colors.fill }]}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={[type.caption, { color: t.colors.labelSecondary, fontWeight: "600" }]}>{meta.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
