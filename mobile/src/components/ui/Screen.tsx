import React from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme/theme";

// Themed screen container. `edges` controls which safe-area insets are padded —
// list screens usually want the top handled by the nav header, so default to none
// and let each screen opt in.
export function Screen({
  children,
  edges = [],
  padded = false,
  style,
}: {
  children: React.ReactNode;
  edges?: ("top" | "bottom")[];
  padded?: boolean;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: t.colors.bg },
        edges.includes("top") && { paddingTop: insets.top },
        edges.includes("bottom") && { paddingBottom: insets.bottom },
        padded && { paddingHorizontal: t.spacing(4) },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { flex: 1 } });
