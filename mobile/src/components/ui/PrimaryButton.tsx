import React from "react";
import { Pressable, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useTheme, type } from "../../theme/theme";

// The filled action button the admin forms end with. Disabled is a real state here, not a hint:
// these screens save explicitly, so "nothing to save" and "saving" both need to look unpressable.
export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
}) {
  const t = useTheme();
  const inactive = disabled || busy;
  const fill = destructive ? t.colors.danger : t.colors.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: inactive ? t.colors.fill : pressed ? t.colors.accentPressed : fill },
      ]}
    >
      {busy ? <ActivityIndicator color={t.colors.labelSecondary} /> : null}
      <Text style={[type.body, { color: inactive ? t.colors.labelTertiary : t.colors.labelOnAccent, fontWeight: "600" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 12, paddingVertical: 14, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
});
