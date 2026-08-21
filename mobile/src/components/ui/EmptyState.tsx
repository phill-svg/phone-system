import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "./Icon";
import { useTheme, type } from "../../theme/theme";

// Shared empty / error / permission state. Same shape everywhere (icon, title,
// message, optional action) so the app reads as one product, per the brief.
export function EmptyState({
  icon,
  title,
  message,
  tone = "neutral",
  action,
}: {
  icon: SymbolViewProps["name"];
  title: string;
  message: string;
  tone?: "neutral" | "danger";
  action?: React.ReactNode;
}) {
  const t = useTheme();
  const tint = tone === "danger" ? t.colors.danger : t.colors.labelTertiary;
  return (
    <View style={styles.wrap}>
      <View style={[styles.iconWrap, { backgroundColor: tone === "danger" ? t.colors.dangerSoft : t.colors.fill }]}>
        <Icon name={icon} size={34} color={tint} />
      </View>
      <Text style={[type.title3, { color: t.colors.label, marginTop: t.spacing(5), textAlign: "center" }]}>{title}</Text>
      <Text style={[type.subhead, { color: t.colors.labelSecondary, marginTop: t.spacing(2), textAlign: "center", maxWidth: 300, lineHeight: 21 }]}>
        {message}
      </Text>
      {action ? <View style={{ marginTop: t.spacing(6) }}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  iconWrap: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
});
