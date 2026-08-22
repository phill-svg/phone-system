import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Screen } from "../../components/ui/Screen";
import { BrandBar } from "../../components/ui/BrandBar";
import { Icon } from "../../components/ui/Icon";
import { Avatar } from "../../components/ui/Avatar";
import { StatusPill } from "../../components/ui/StatusPill";
import { DialPad } from "../../components/keypad/DialPad";
import { getContacts, type Contact } from "../../lib/api";
import { formatPhone, matchContacts } from "../../lib/phone";
import { haptics } from "../../theme/haptics";
import { useTheme, type } from "../../theme/theme";

export default function KeypadScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [number, setNumber] = useState("");
  const { data: contacts } = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });

  const suggestions = useMemo(() => matchContacts(number, contacts ?? []), [number, contacts]);
  const display = number ? formatPhone(number) : "";

  function startCall(target: string, name?: string) {
    const dialed = target.trim();
    if (!dialed) return;
    haptics.medium();
    router.push({ pathname: "/call-active", params: { number: dialed, name: name ?? "" } });
  }

  async function paste() {
    const text = await Clipboard.getStringAsync();
    const cleaned = text.replace(/[^\d+*#]/g, "");
    if (cleaned) {
      haptics.tap();
      setNumber(cleaned);
    }
  }

  return (
    <Screen>
      <BrandBar right={<StatusPill />} />

      {/* Number display */}
      <View style={styles.displayWrap}>
        <Text
          style={[styles.display, { color: t.colors.label }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          selectable
        >
          {display}
        </Text>
        {number ? (
          <Pressable onPress={() => { haptics.tap(); router.push({ pathname: "/contact-edit", params: { phone: number } }); }} hitSlop={10} style={styles.addContact}>
            <Icon name="person.crop.circle.badge.plus" fallback="person-add" size={22} color={t.colors.accent} />
            <Text style={[type.footnote, { color: t.colors.accent, fontWeight: "600" }]}>Add Number</Text>
          </Pressable>
        ) : (
          <Text style={[type.subhead, { color: t.colors.labelTertiary }]}>Enter a number</Text>
        )}
      </View>

      {/* Contact suggestions */}
      <View style={styles.suggestions}>
        {suggestions.length > 0 ? (
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 132 }}>
            {suggestions.map((c: Contact) => (
              <Pressable
                key={c.id}
                onPress={() => startCall(c.phone, c.name)}
                style={({ pressed }) => [styles.suggestionRow, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
              >
                <Avatar name={c.name} size={38} />
                <View style={{ flex: 1 }}>
                  <Text style={[type.callout, { color: t.colors.label, fontWeight: "600" }]} numberOfLines={1}>{c.name}</Text>
                  <Text style={[type.footnote, { color: t.colors.labelSecondary }]} numberOfLines={1}>
                    {c.company ? `${c.company} · ` : ""}{formatPhone(c.phone)}
                  </Text>
                </View>
                <Icon name="phone.fill" fallback="call" size={18} color={t.colors.success} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>

      {/* Keypad + call row pinned to lower area for one-handed use */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + t.spacing(3) }]}>
        <DialPad onKey={(c) => setNumber((n) => n + c)} />

        <View style={styles.callRow}>
          <View style={styles.side}>
            <Pressable onPress={paste} hitSlop={8} style={styles.sideBtn}>
              <Icon name="doc.on.clipboard" fallback="clipboard" size={22} color={t.colors.labelSecondary} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => startCall(number)}
            disabled={!number}
            style={({ pressed }) => [
              styles.callBtn,
              { backgroundColor: number ? (pressed ? t.colors.accentPressed : "#2FA84F") : t.colors.fill },
            ]}
          >
            <Icon name="phone.fill" fallback="call" size={34} color={number ? "#FFFFFF" : t.colors.labelTertiary} />
          </Pressable>

          <View style={styles.side}>
            {number ? (
              <Pressable
                onPress={() => { haptics.tap(); setNumber((n) => n.slice(0, -1)); }}
                onLongPress={() => setNumber("")}
                hitSlop={8}
                style={styles.sideBtn}
              >
                <Icon name="delete.left.fill" fallback="backspace" size={26} color={t.colors.labelSecondary} />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { alignItems: "center", paddingBottom: 4 },
  displayWrap: { alignItems: "center", paddingHorizontal: 24, minHeight: 76, justifyContent: "center", gap: 4 },
  display: { fontSize: 40, fontWeight: "300", letterSpacing: 1 },
  addContact: { flexDirection: "row", alignItems: "center", gap: 5 },
  suggestions: { paddingHorizontal: 16, flexShrink: 1 },
  suggestionRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 12 },
  bottom: { marginTop: "auto", paddingHorizontal: 24, gap: 18 },
  callRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", maxWidth: 320, alignSelf: "center", width: "100%" },
  side: { flex: 1, alignItems: "center" },
  sideBtn: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  callBtn: { width: 74, height: 74, borderRadius: 37, alignItems: "center", justifyContent: "center" },
});
