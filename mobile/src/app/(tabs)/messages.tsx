import React from "react";
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { LargeHeader } from "../../components/ui/LargeHeader";
import { StatusPill } from "../../components/ui/StatusPill";
import { EmptyState } from "../../components/ui/EmptyState";
import { Avatar } from "../../components/ui/Avatar";
import { Icon } from "../../components/ui/Icon";
import { getConversations, getContacts, type Conversation } from "../../lib/api";
import { formatPhone, contactForNumber } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit" });
}

export default function MessagesScreen() {
  const t = useTheme();
  const convos = useQuery({ queryKey: ["conversations"], queryFn: getConversations });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts, staleTime: 60_000 });

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      <Pressable onPress={() => router.push({ pathname: "/thread/[number]", params: { number: "new" } })} hitSlop={8}>
        <Icon name="square.and.pencil" fallback="create-outline" size={23} color={t.colors.accent} weight="semibold" />
      </Pressable>
      <StatusPill />
    </View>
  );

  function title(c: Conversation): string {
    return c.name ?? contactForNumber(c.number, contacts.data ?? [])?.name ?? formatPhone(c.number) ?? c.number;
  }

  return (
    <Screen edges={["top"]}>
      <LargeHeader title="Messages" right={header} />
      {convos.isLoading ? (
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 48 }} />
      ) : (convos.data ?? []).length === 0 ? (
        <EmptyState
          icon="message"
          title="No Messages"
          message="Text your customers from your business number. Conversations will appear here once messaging is connected."
        />
      ) : (
        <FlatList
          data={convos.data}
          keyExtractor={(c) => c.number}
          onRefresh={convos.refetch}
          refreshing={convos.isFetching && !convos.isLoading}
          contentContainerStyle={{ paddingHorizontal: 16 }}
          ItemSeparatorComponent={() => <View style={[styles.sep, { backgroundColor: t.colors.separator, marginLeft: 66 }]} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: "/thread/[number]", params: { number: item.number } })}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.cardPressed : "transparent" }]}
            >
              <Avatar name={title(item)} size={50} />
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={[type.body, { color: t.colors.label, fontWeight: "600", flex: 1 }]} numberOfLines={1}>{title(item)}</Text>
                  <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{when(item.last_ts)}</Text>
                </View>
                <Text style={[type.subhead, { color: item.unread > 0 ? t.colors.label : t.colors.labelSecondary }]} numberOfLines={2}>
                  {item.last_body}
                </Text>
              </View>
              {item.unread > 0 ? <View style={[styles.unread, { backgroundColor: t.colors.accent }]} /> : null}
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  unread: { width: 9, height: 9, borderRadius: 5 },
  sep: { height: StyleSheet.hairlineWidth },
});
