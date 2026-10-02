import React, { useState } from "react";
import { ScrollView, View, Text, Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/ui/Screen";
import { Group, Row } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { ApiError, lookupServiceM8Contacts, saveServiceM8Contacts, type ServiceM8Match } from "../../lib/api";
import { lookupAllInServiceM8 } from "../../lib/contactSync";
import { formatPhone } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

// Admin > Sync Contacts. Checks every number that has called or texted and is not saved against
// ServiceM8, shows the matches with a switch each (all on), and saves only the ones left on. The
// server never overwrites a contact that is already saved. Admin-only: this screen sits under
// /admin, whose layout bounces anyone else, and both routes it calls are under /api/admin/.
// Starts on a button rather than on mount, so opening the screen never searches ServiceM8 by itself.
export default function ContactSyncScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [matches, setMatches] = useState<ServiceM8Match[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  async function check() {
    if (checking || saving) return;
    setChecking(true);
    setMatches(null);
    setStatus("Checking ServiceM8…");
    try {
      const result = await lookupAllInServiceM8(lookupServiceM8Contacts, (done, total) =>
        setStatus(`Checking ServiceM8… ${done} of ${total}`)
      );
      let summary =
        result.checked === 0
          ? "Every number that has called or texted is already saved."
          : `Found ${result.matches.length} of ${result.checked} unsaved numbers in ServiceM8.`;
      if (result.failed) summary += ` ${result.failed} could not be checked.`;
      setStatus(summary);
      setMatches(result.matches);
      setChosen(new Set(result.matches.map((m) => m.phone)));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Couldn't reach ServiceM8.");
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!matches || saving) return;
    const picked = matches.filter((m) => chosen.has(m.phone)).map(({ phone, name }) => ({ phone, name }));
    if (picked.length === 0) {
      Alert.alert("Nothing selected", "Turn on at least one contact to save.");
      return;
    }
    setSaving(true);
    try {
      const { saved, skipped } = await saveServiceM8Contacts(picked);
      setStatus(
        `Saved ${saved} ${saved === 1 ? "contact" : "contacts"}` +
          (skipped ? ` (${skipped} already saved, left as they were).` : ".")
      );
      setMatches(null);
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof ApiError ? e.message : "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  function toggle(phone: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(phone);
      else next.delete(phone);
      return next;
    });
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Group footer="Checks every number that has called or texted and isn't saved yet. You choose which matches to save; a contact that is already saved is never changed.">
          <Row
            icon="arrow.triangle.2.circlepath"
            iconFallback="sync"
            iconColor="#007AFF"
            label={checking ? "Checking…" : "Check ServiceM8"}
            onPress={checking || saving ? undefined : check}
          />
        </Group>

        {status ? (
          <Text style={[type.footnote, { color: t.colors.labelSecondary, marginHorizontal: 32, marginTop: 16 }]}>{status}</Text>
        ) : null}

        {matches && matches.length > 0 ? (
          <>
            <Group title="Found in ServiceM8">
              {matches.map((m) => (
                <Row
                  key={m.phone}
                  label={m.name}
                  value={formatPhone(m.phone)}
                  toggle={chosen.has(m.phone)}
                  onToggle={(on) => toggle(m.phone, on)}
                />
              ))}
            </Group>
            <View style={{ marginHorizontal: 16, marginTop: 20 }}>
              <PrimaryButton
                label={`Save ${chosen.size} ${chosen.size === 1 ? "contact" : "contacts"}`}
                onPress={save}
                disabled={chosen.size === 0}
                busy={saving}
              />
            </View>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
