import React, { useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, KeyboardAvoidingView, Platform, Alert, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Icon } from "../../components/ui/Icon";
import { EmptyState } from "../../components/ui/EmptyState";
import { getThread, getContacts, sendMessage, type Message } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { haptics } from "../../theme/haptics";
import { useTheme, type } from "../../theme/theme";

export default function ThreadScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ number?: string }>();
  const isNew = params.number === "new";
  const [to, setTo] = useState(isNew ? "" : String(params.number ?? ""));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });
  const thread = useQuery({ queryKey: ["thread", to], queryFn: () => getThread(to), enabled: !isNew && to.length > 2 });

  const contactName = contactForNumber(to, contacts.data ?? [])?.name;
  const title = contactName ?? (to ? formatPhone(to) : "New Message");

  async function send() {
    const body = text.trim();
    if (!body || !to.trim() || sending) return;
    setSending(true);
    const ok = await sendMessage(to.trim(), body);
    setSending(false);
    if (ok) {
      haptics.success();
      setText("");
      qc.invalidateQueries({ queryKey: ["thread", to] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } else {
      haptics.warning();
      Alert.alert("Not connected yet", "Messaging turns on once your TCB number is linked for SMS. Your draft is kept.");
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top }}>
      {/* Header */}
      <View style={[styles.bar, { borderBottomColor: t.colors.separator }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <Icon name="chevron.left" fallback="chevron-back" size={22} color={t.colors.accent} />
        </Pressable>
        <Text style={[type.headline, { color: t.colors.label }]} numberOfLines={1}>{title}</Text>
        <View style={{ width: 40 }} />
      </View>

      {isNew ? (
        <View style={[styles.toRow, { borderBottomColor: t.colors.separator }]}>
          <Text style={[type.subhead, { color: t.colors.labelSecondary }]}>To:</Text>
          <TextInput
            value={to}
            onChangeText={setTo}
            placeholder="Phone number"
            placeholderTextColor={t.colors.labelTertiary}
            keyboardType="phone-pad"
            autoFocus
            style={[type.body, { color: t.colors.label, flex: 1 }]}
          />
        </View>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        {(thread.data ?? []).length === 0 ? (
          <EmptyState
            icon="message"
            title={isNew ? "New Message" : "No Messages Yet"}
            message={isNew ? "Enter a number above and write your message." : "Send the first message below."}
          />
        ) : (
          <FlatList
            data={thread.data}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            renderItem={({ item }: { item: Message }) => {
              const out = item.direction === "outbound";
              return (
                <View style={[styles.bubbleRow, { justifyContent: out ? "flex-end" : "flex-start" }]}>
                  <View style={[styles.bubble, out ? { backgroundColor: t.colors.accent } : { backgroundColor: t.colors.fill }]}>
                    <Text style={[type.body, { color: out ? "#FFFFFF" : t.colors.label }]}>{item.body}</Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        {/* Compose */}
        <View style={[styles.compose, { borderTopColor: t.colors.separator, paddingBottom: insets.bottom + 8 }]}>
          <View style={[styles.inputWrap, { backgroundColor: t.colors.fill }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Text Message"
              placeholderTextColor={t.colors.labelTertiary}
              style={[type.body, { color: t.colors.label, flex: 1, maxHeight: 100 }]}
              multiline
            />
          </View>
          <Pressable onPress={send} disabled={!text.trim() || !to.trim() || sending} style={[styles.sendBtn, { backgroundColor: text.trim() && to.trim() ? t.colors.accent : t.colors.fill }]}>
            <Icon name="arrow.up" fallback="arrow-up" size={20} color={text.trim() && to.trim() ? "#FFFFFF" : t.colors.labelTertiary} weight="semibold" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 40, height: 32, alignItems: "flex-start", justifyContent: "center" },
  toRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  bubbleRow: { flexDirection: "row" },
  bubble: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20 },
  compose: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  inputWrap: { flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, minHeight: 38, justifyContent: "center" },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
});
