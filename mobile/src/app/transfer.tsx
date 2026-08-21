import React, { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Segmented } from "../components/ui/Segmented";
import { Avatar } from "../components/ui/Avatar";
import { Icon } from "../components/ui/Icon";
import { getContacts, type Contact } from "../lib/api";
import { formatPhone, normalizePhone } from "../lib/phone";
import { haptics } from "../theme/haptics";
import { useTheme, type } from "../theme/theme";

export default function TransferScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"blind" | "attended">("blind");
  const [q, setQ] = useState("");
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts });

  const results = useMemo(() => {
    const list = contacts.data ?? [];
    const needle = q.trim().toLowerCase();
    const digits = normalizePhone(q);
    if (!needle) return list;
    return list.filter((c) => c.name.toLowerCase().includes(needle) || (digits.length >= 2 && c.phone_normalized.includes(digits)));
  }, [contacts.data, q]);

  function transferTo(number: string, name?: string) {
    haptics.medium();
    if (mode === "attended") {
      // Attended: call the target first so the agent can speak before completing.
      router.replace({ pathname: "/call-active", params: { number, name: name ?? "" } });
    } else {
      // Blind: hand the caller straight over and return to the call surface.
      router.back();
    }
  }

  const typedIsNumber = normalizePhone(q).length >= 4;

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top }}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Text style={[type.body, { color: t.colors.accent }]}>Cancel</Text></Pressable>
        <Text style={[type.headline, { color: t.colors.label }]}>Transfer</Text>
        <View style={{ width: 54 }} />
      </View>

      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <Segmented value={mode} onChange={setMode} options={[{ label: "Blind", value: "blind" }, { label: "Attended", value: "attended" }]} />
        <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>
          {mode === "blind" ? "Hand the caller straight to the person you choose." : "Call the person first, speak, then complete the transfer."}
        </Text>
        <View style={[styles.search, { backgroundColor: t.colors.fill }]}>
          <Icon name="magnifyingglass" fallback="search" size={17} color={t.colors.labelTertiary} />
          <TextInput value={q} onChangeText={setQ} placeholder="Name or number" placeholderTextColor={t.colors.labelTertiary} style={[styles.input, { color: t.colors.label }]} keyboardType="default" autoCapitalize="none" />
        </View>
      </View>

      <FlatList
        data={results}
        keyExtractor={(c) => String(c.id)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6 }}
        ListHeaderComponent={
          typedIsNumber ? (
            <Pressable onPress={() => transferTo(q)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}>
              <View style={[styles.numTile, { backgroundColor: t.colors.accentSoft }]}>
                <Icon name="phone.arrow.up.right.fill" fallback="call" size={18} color={t.colors.accent} />
              </View>
              <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]}>Transfer to {formatPhone(q)}</Text>
            </Pressable>
          ) : null
        }
        ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 54 }]} />}
        renderItem={({ item }: { item: Contact }) => (
          <Pressable onPress={() => transferTo(item.phone, item.name)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}>
            <Avatar name={item.name} size={42} />
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>{item.name}</Text>
              <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>{item.company ? `${item.company} · ` : ""}{formatPhone(item.phone)}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  search: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10 },
  input: { flex: 1, fontSize: 17, padding: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  numTile: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  sep: { height: StyleSheet.hairlineWidth },
});
