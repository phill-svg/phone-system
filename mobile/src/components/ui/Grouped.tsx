import React from "react";
import { View, Text, Pressable, Switch, StyleSheet } from "react-native";
import { type SymbolViewProps } from "expo-symbols";
import { Icon } from "./Icon";
import { useTheme, type } from "../../theme/theme";

// iOS grouped-list building blocks. `Group` draws the inset card + optional
// caption; `Row` is a single line with an optional leading icon and a trailing
// control (value text, chevron, or switch).
export function Group({ title, footer, children }: { title?: string; footer?: string; children: React.ReactNode }) {
  const t = useTheme();
  const items = React.Children.toArray(children);
  return (
    <View style={{ marginTop: t.spacing(6) }}>
      {title ? (
        <Text style={[type.footnote, styles.title, { color: t.colors.labelSecondary }]}>{title.toUpperCase()}</Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: t.colors.card }]}>
        {items.map((child, i) => (
          <View key={i}>
            {i > 0 ? <View style={[styles.sep, { backgroundColor: t.colors.separator }]} /> : null}
            {child}
          </View>
        ))}
      </View>
      {footer ? <Text style={[type.caption, styles.footer, { color: t.colors.labelTertiary }]}>{footer}</Text> : null}
    </View>
  );
}

export function Row({
  icon,
  iconFallback,
  iconColor,
  label,
  value,
  toggle,
  onToggle,
  toggleDisabled,
  onPress,
  chevron,
  destructive,
}: {
  icon?: SymbolViewProps["name"];
  // Android renders Ionicons, and `Icon` falls back to a blank `ellipse-outline` for any name
  // given without one -- so a row with no fallback is a coloured tile containing nothing on every
  // Android handset, while looking perfect on iOS. Optional only because the existing call sites
  // predate this; anything new should pass it.
  iconFallback?: React.ComponentProps<typeof Icon>["fallback"];
  iconColor?: string;
  label: string;
  value?: string;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  // For a toggle whose real value has not loaded yet. A switch defaulted to `false` while the server
  // says `true` invites the admin to "turn it on" (a no-op) and then off again to test -- which
  // genuinely disables it. Better to be visibly not-ready than confidently wrong.
  toggleDisabled?: boolean;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
}) {
  const t = useTheme();
  const body = (
    <>
      {icon ? (
        <View style={[styles.iconTile, { backgroundColor: iconColor ?? t.colors.labelSecondary }]}>
          <Icon name={icon} fallback={iconFallback} size={16} color="#FFFFFF" />
        </View>
      ) : null}
      <Text style={[type.body, { color: destructive ? t.colors.danger : t.colors.label, flex: 1 }]} numberOfLines={1}>
        {label}
      </Text>
      {value ? <Text style={[type.body, { color: t.colors.labelSecondary }]} numberOfLines={1}>{value}</Text> : null}
      {toggle !== undefined ? (
        <Switch
          value={toggle}
          onValueChange={onToggle}
          disabled={toggleDisabled}
          trackColor={{ true: t.colors.accent }}
          style={toggleDisabled ? { opacity: 0.4 } : undefined}
        />
      ) : chevron ? (
        <Icon name="chevron.right" fallback="chevron-forward" size={15} color={t.colors.labelTertiary} />
      ) : null}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}>
        {body}
      </Pressable>
    );
  }
  return <View style={styles.row}>{body}</View>;
}

const styles = StyleSheet.create({
  title: { marginLeft: 32, marginBottom: 7, fontWeight: "500" },
  footer: { marginTop: 7, marginHorizontal: 32, lineHeight: 16 },
  card: { marginHorizontal: 16, borderRadius: 12, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 46 },
  iconTile: { width: 29, height: 29, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
});
