import React, { useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, Alert, StyleSheet, Platform } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Icon } from "../../components/ui/Icon";
import { EmptyState } from "../../components/ui/EmptyState";
import { getThread, getContacts, sendMessage, getNumbers, type Message } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { haptics } from "../../theme/haptics";
import { useTheme, type } from "../../theme/theme";

export default function ThreadScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ number?: string; name?: string }>();
  const isNew = params.number === "new";
  const [to, setTo] = useState(isNew ? "" : String(params.number ?? ""));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });
  const thread = useQuery({ queryKey: ["thread", to], queryFn: () => getThread(to), enabled: !isNew && to.length > 2 });
  const numbers = useQuery({ queryKey: ["numbers"], queryFn: getNumbers, staleTime: 300_000 });

  const smsNums = (numbers.data ?? []).filter((n) => n.sms_enabled);
  const [fromNum, setFromNum] = useState<string | null>(null);
  // Effective sending number: the picked one, else the default SMS number, else the first available.
  const effectiveFrom = fromNum ?? smsNums.find((n) => n.is_default_sms)?.e164 ?? smsNums[0]?.e164;

  const contactName = contactForNumber(to, contacts.data ?? [])?.name;
  const isMessenger = to.startsWith("messenger:");
  const title = contactName ?? params.name ?? (isMessenger ? "Facebook user" : (to ? formatPhone(to) : "New Message"));

  async function send() {
    const body = text.trim();
    if (!body || !to.trim() || sending) return;
    setSending(true);
    const ok = await sendMessage(to.trim(), body, effectiveFrom);
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
        <View style={styles.titleRow}>
          <Text style={[type.headline, { color: t.colors.label, flexShrink: 1 }]} numberOfLines={1}>{title}</Text>
          {isMessenger ? <Icon name="message.fill" fallback="logo-facebook" size={14} color="#0866FF" /> : null}
        </View>
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
            style={{ fontSize: 17, fontWeight: "400", color: t.colors.label, flex: 1 }}
          />
        </View>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        {(thread.data ?? []).length === 0 ? (
          <View style={{ flex: 1 }}>
            <EmptyState
              icon="message"
              title={isNew ? "New Message" : "No Messages Yet"}
              message={isNew ? "Enter a number above and write your message." : "Send the first message below."}
            />
          </View>
        ) : (
          <FlatList
            style={{ flex: 1 }}
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

        {/* "From" picker — a chip row when there are 2+ SMS numbers, a static line for one, hidden for none. */}
        {smsNums.length >= 2 ? (
          <View style={[styles.fromBar, { borderTopColor: t.colors.separator }]}>
            <Text style={[type.caption, { color: t.colors.labelSecondary }]}>From</Text>
            {smsNums.map((n) => {
              const active = effectiveFrom === n.e164;
              return (
                <Pressable key={n.id} onPress={() => setFromNum(n.e164)} style={[styles.fromChip, { backgroundColor: active ? t.colors.accent : t.colors.fill }]}>
                  <Text style={[type.caption, { color: active ? "#FFFFFF" : t.colors.label }]}>{n.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : smsNums.length === 1 ? (
          <View style={[styles.fromBar, { borderTopColor: t.colors.separator }]}>
            <Text style={[type.caption, { color: t.colors.labelSecondary }]}>From {smsNums[0].label} · {formatPhone(smsNums[0].e164)}</Text>
          </View>
        ) : null}

        {/* Compose */}
        <View style={[styles.compose, { borderTopColor: t.colors.separator, paddingBottom: insets.bottom + 8 }]}>
          <View style={[styles.inputWrap, { backgroundColor: t.colors.fill }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Text Message"
              placeholderTextColor={t.colors.labelTertiary}
              selectionColor={t.colors.accent}
              // Samsung One UI renders the keyboard's *composing* text (the underlined word before you
              // press space) in WHITE on multiline fields, ignoring `color` — so typing looked invisible
              // on the S25 FE. Just disabling autocorrect wasn't enough. keyboardType="visible-password"
              // on Android forces a no-composing keyboard, so every character commits immediately in the
              // real text colour. iOS keeps the normal keyboard.
              keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              style={{ fontSize: 17, fontWeight: "400", color: t.colors.label, flex: 1, maxHeight: 100, textAlignVertical: "top" }}
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
  titleRow: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  back: { width: 40, height: 32, alignItems: "flex-start", justifyContent: "center" },
  toRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  bubbleRow: { flexDirection: "row" },
  bubble: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20 },
  fromBar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth },
  fromChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  compose: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  inputWrap: { flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, minHeight: 38, justifyContent: "center" },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
});
