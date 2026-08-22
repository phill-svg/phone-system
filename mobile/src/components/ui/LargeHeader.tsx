import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BrandBar } from "./BrandBar";
import { useTheme, type } from "../../theme/theme";

// The red TCB brand bar plus an iOS-style large title below it. Screens hide the tab-bar's
// own header so the title gets the big native look with a trailing accessory slot.
export function LargeHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View>
      <BrandBar />
      <View style={styles.titleRow}>
        <Text style={[type.largeTitle, { color: t.colors.label }]} numberOfLines={1}>
          {title}
        </Text>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  right: { paddingBottom: 6 },
});
