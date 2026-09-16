import React, { useMemo } from "react";
import { ScrollView, View, Text, Pressable, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { placeCall } from "../../lib/placeCall";
import { useUserSettings } from "../../lib/userSettings";
import { router, useLocalSearchParams } from "expo-router";
import { type SymbolViewProps } from "expo-symbols";
import { Screen } from "../../components/ui/Screen";
import { Avatar } from "../../components/ui/Avatar";
import { Icon } from "../../components/ui/Icon";
import { Group, Row } from "../../components/ui/Grouped";
import { EmptyState } from "../../components/ui/EmptyState";
import { getContacts, getCallsForNumber } from "../../lib/api";
import { formatPhone } from "../../lib/phone";
import { haptics } from "../../theme/haptics";
import { useTheme, type } from "../../theme/theme";

function QuickAction({ icon, fallback, label, onPress, color }: { icon: SymbolViewProps["name"]; fallback: string; label: string; onPress: () => void; color: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={styles.quick}>
      <View style={[styles.quickIcon, { backgroundColor: t.colors.card }]}>
        <Icon name={icon} fallback={fallback as never} size={22} color={color} />
      </View>
      <Text style={[type.caption, { color: t.colors.accent, fontWeight: "600" }]}>{label}</Text>
    </Pressable>
  );
}

export default function ContactDetailScreen() {
  const { settings } = useUserSettings();
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts });
  const contact = (contacts.data ?? []).find((c) => String(c.id) === String(id));
  // A DEDICATED query, not a filter over the capped ["calls"] list that Recents uses -- that list
  // only ever holds the 50 most recent calls from EVERYONE, so a contact's own calls silently
  // vanished from here the moment enough other calls pushed theirs past the cutoff. Its own query
  // key, or this would overwrite Recents' cached ["calls"] entry with just this contact's calls.
  const calls = useQuery({
    queryKey: ["calls", "byNumber", contact?.phone_normalized],
    queryFn: () => getCallsForNumber(contact!.phone),
    enabled: !!contact,
  });

  const history = useMemo(() => (calls.data ?? []).slice(0, 8), [calls.data]);

  if (!contact) {
    return (
      <Screen edges={["top"]}>
        <EmptyState icon="person.crop.circle.badge.questionmark" title="Contact Not Found" message="This contact may have been removed." />
      </Screen>
    );
  }

  function call() {
    haptics.medium();
    placeCall({ number: contact!.phone, name: contact!.name, settings });
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.identity}>
          <Avatar name={contact.name} size={96} />
          <Text style={[type.title2, { color: t.colors.label, marginTop: 14, textAlign: "center" }]}>{contact.name}</Text>
          {contact.company ? <Text style={[type.callout, { color: t.colors.labelSecondary, marginTop: 2 }]}>{contact.company}</Text> : null}
        </View>

        <View style={styles.quickRow}>
          <QuickAction icon="message.fill" fallback="chatbubble" label="message" color="#34C759" onPress={() => router.push({ pathname: "/thread/[number]", params: { number: contact!.phone } })} />
          <QuickAction icon="phone.fill" fallback="call" label="call" color="#34C759" onPress={call} />
          <QuickAction icon="video.fill" fallback="videocam" label="voip" color={t.colors.accent} onPress={call} />
        </View>

        <Group title="Phone">
          <Row icon="phone.fill" iconColor="#34C759" label={formatPhone(contact.phone)} onPress={call} chevron />
        </Group>

        {history.length > 0 ? (
          <Group title="Recent Calls">
            {history.map((h) => (
              <Row
                key={h.id}
                icon={h.direction === "outbound" ? "arrow.up.right" : "arrow.down.left"}
                iconColor={t.colors.labelSecondary}
                label={h.direction === "outbound" ? "Outgoing" : "Incoming"}
                value={new Date(h.started_at).toLocaleDateString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                onPress={() => router.push(`/call/${encodeURIComponent(h.id)}`)}
                chevron
              />
            ))}
          </Group>
        ) : null}

        <Group>
          <Row icon="pencil" iconColor="#8E8E93" label="Edit Contact" chevron onPress={() => router.push({ pathname: "/contact-edit", params: { id: String(contact.id) } })} />
        </Group>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: { alignItems: "center", paddingTop: 16, paddingHorizontal: 24 },
  quickRow: { flexDirection: "row", justifyContent: "center", gap: 28, marginTop: 20 },
  quick: { alignItems: "center", gap: 6 },
  quickIcon: { width: 56, height: 56, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
