import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Icon } from "./Icon";

// Deterministic avatar: initials on a colour derived from the name, so the same
// contact always gets the same tile. Unknown callers fall back to a person glyph.
const PALETTE = ["#E4002B", "#0A84FF", "#30B0C7", "#5E5CE6", "#FF9500", "#34C759", "#FF375F", "#AF52DE", "#8E8E93"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({ name, size = 44 }: { name?: string | null; size?: number }) {
  const trimmed = (name ?? "").trim();
  const known = trimmed.length > 0;
  const bg = known ? colorFor(trimmed) : "#8E8E93";
  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      {known ? (
        <Text style={[styles.initials, { fontSize: size * 0.4 }]} numberOfLines={1}>
          {initials(trimmed)}
        </Text>
      ) : (
        <Icon name="person.fill" fallback="person" size={size * 0.5} color="#FFFFFF" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
  initials: { color: "#FFFFFF", fontWeight: "600" },
});
