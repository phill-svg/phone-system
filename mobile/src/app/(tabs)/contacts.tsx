import React, { useMemo, useState } from "react";
import { View, Text, Pressable, SectionList, TextInput, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { EmptyState } from "../../components/ui/EmptyState";
import { Avatar } from "../../components/ui/Avatar";
import { Icon } from "../../components/ui/Icon";
import { getContacts, type Contact } from "../../lib/api";
import { normalizePhone } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

export default function ContactsScreen() {
  const t = useTheme();
  const [q, setQ] = useState("");
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts });

  const sections = useMemo(() => {
    const list = contacts.data ?? [];
    const needle = q.trim().toLowerCase();
    const digits = normalizePhone(q);
    const filtered = needle
      ? list.filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.company ?? "").toLowerCase().includes(needle) ||
            (digits.length >= 2 && c.phone_normalized.includes(digits))
        )
      : list;
    const byLetter = new Map<string, Contact[]>();
    for (const c of filtered) {
      const letter = (c.name[0] ?? "#").toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : "#";
      (byLetter.get(key) ?? byLetter.set(key, []).get(key)!).push(c);
    }
    return [...byLetter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([title, data]) => ({ title, data }));
  }, [contacts.data, q]);

  const header = (
    <View style={styles.headerRight}>
      <Pressable onPress={() => router.push("/contact-edit")} hitSlop={8}>
        <Icon name="plus" fallback="add" size={24} color={t.colors.accent} weight="semibold" />
      </Pressable>
      <StatusPill />
    </View>
  );

  return (
    <Screen>
      <LargeHeader title="Contacts" right={header} />
      <View style={[styles.search, { backgroundColor: t.colors.fill }]}>
        <Icon name="magnifyingglass" fallback="search" size={17} color={t.colors.labelTertiary} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search"
          placeholderTextColor={t.colors.labelTertiary}
          style={[styles.searchInput, { color: t.colors.label }]}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      {contacts.isLoading ? (
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />
      ) : contacts.isError ? (
        <EmptyState icon="wifi.exclamationmark" title="Couldn't load contacts" message="Check your connection and try again." tone="danger" />
      ) : sections.length === 0 ? (
        <EmptyState
          icon="person.crop.circle.badge.plus"
          title={q ? "No Matches" : "No Contacts"}
          message={q ? "Try a different name or number." : "Add a contact to get started."}
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(c) => String(c.id)}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={[type.footnote, styles.sectionHeader, { color: t.colors.labelSecondary }]}>{section.title}</Text>
          )}
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 54 }]} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: "/contact/[id]", params: { id: String(item.id) } })}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
            >
              <Avatar name={item.name} size={42} />
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>{item.name}</Text>
                {item.company ? <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>{item.company}</Text> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: 14 },
  search: { flexDirection: "row", alignItems: "center", gap: 7, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10 },
  searchInput: { flex: 1, fontSize: 17, padding: 0 },
  sectionHeader: { fontWeight: "700", paddingTop: 14, paddingBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9 },
  sep: { height: StyleSheet.hairlineWidth },
});
