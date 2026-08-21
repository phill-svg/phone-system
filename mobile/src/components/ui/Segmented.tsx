import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useTheme } from "../../theme/theme";
import { haptics } from "../../theme/haptics";

// iOS-style segmented control. Keep the option count small (2–4) for one-handed use.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: t.colors.fill }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (!active) haptics.tap();
              onChange(o.value);
            }}
            style={[styles.seg, active && { backgroundColor: t.colors.bgElevated }]}
          >
            <Text style={[styles.label, { color: active ? t.colors.label : t.colors.labelSecondary, fontWeight: active ? "600" : "500" }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", borderRadius: 9, padding: 2, gap: 2 },
  seg: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: "center" },
  label: { fontSize: 13.5 },
});
