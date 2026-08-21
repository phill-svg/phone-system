import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Group } from "../components/ui/Grouped";
import { getContacts, createContact, updateContact, deleteContact } from "../lib/api";
import { useTheme, type } from "../theme/theme";
import { haptics } from "../theme/haptics";

export default function ContactEditScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ id?: string; phone?: string }>();
  const editing = !!params.id;
  const existing = useQuery({ queryKey: ["contacts"], queryFn: getContacts, enabled: editing }).data?.find((c) => String(c.id) === String(params.id));

  const [name, setName] = useState(existing?.name ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? String(params.phone ?? ""));
  const [company, setCompany] = useState(existing?.company ?? "");
  const [busy, setBusy] = useState(false);

  const canSave = name.trim().length > 0 && phone.trim().length >= 3;

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      const input = { name: name.trim(), phone: phone.trim(), company: company.trim() || null };
      if (editing && existing) await updateContact(existing.id, input);
      else await createContact(input);
      await qc.invalidateQueries({ queryKey: ["contacts"] });
      haptics.success();
      router.back();
    } catch {
      haptics.error();
      Alert.alert("Couldn't save", "Please check the details and try again.");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!existing) return;
    Alert.alert("Delete Contact", `Remove ${existing.name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteContact(existing.id);
            await qc.invalidateQueries({ queryKey: ["contacts"] });
            haptics.success();
            router.back();
          } catch {
            Alert.alert("Couldn't delete", "Please try again.");
          }
        },
      },
    ]);
  }

  const field = (label: string, value: string, onChange: (v: string) => void, extra?: object) => (
    <View style={[styles.field, { borderBottomColor: t.colors.separator }]}>
      <Text style={[type.subhead, { color: t.colors.labelSecondary, width: 84 }]}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} placeholderTextColor={t.colors.labelTertiary} style={[styles.input, { color: t.colors.label }]} {...extra} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top }}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Text style={[type.body, { color: t.colors.accent }]}>Cancel</Text></Pressable>
        <Text style={[type.headline, { color: t.colors.label }]}>{editing ? "Edit Contact" : "New Contact"}</Text>
        <Pressable onPress={save} hitSlop={10} disabled={!canSave || busy}>
          {busy ? <ActivityIndicator color={t.colors.accent} /> : <Text style={[type.headline, { color: canSave ? t.colors.accent : t.colors.labelTertiary }]}>Save</Text>}
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={[styles.card, { backgroundColor: t.colors.card }]}>
          {field("Name", name, setName, { placeholder: "Full name", autoCapitalize: "words" })}
          {field("Phone", phone, setPhone, { placeholder: "Phone number", keyboardType: "phone-pad" })}
          {field("Company", company, setCompany, { placeholder: "Optional", autoCapitalize: "words" })}
        </View>

        {editing ? (
          <Group>
            <Pressable onPress={confirmDelete} style={styles.deleteRow}>
              <Text style={[type.body, { color: t.colors.danger }]}>Delete Contact</Text>
            </Pressable>
          </Group>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  card: { marginHorizontal: 16, marginTop: 20, borderRadius: 12, overflow: "hidden" },
  field: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, fontSize: 17, padding: 0 },
  deleteRow: { paddingHorizontal: 14, paddingVertical: 12, alignItems: "center" },
});
