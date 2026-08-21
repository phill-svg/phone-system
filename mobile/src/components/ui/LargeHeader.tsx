import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type } from "../../theme/theme";

// iOS-style large-title header rendered inside each screen (we hide the tab-bar's
// own header so titles get the big, native look with a trailing accessory slot).
export function LargeHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + t.spacing(2) }]}>
      <Text style={[type.largeTitle, { color: t.colors.label }]} numberOfLines={1}>
        {title}
      </Text>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  right: { paddingBottom: 6 },
});
