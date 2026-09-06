import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable, ActivityIndicator, Alert } from "react-native";
import { Screen } from "../../components/ui/Screen";
import { Group } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Icon } from "../../components/ui/Icon";
import { getCallBlocklist, setCallBlocklist } from "../../lib/api";
import { toE164 } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

// Numbers the IVR drops before they ever ring anyone. Stored as a plain list and matched against
// the caller ID Twilio reports, so entries are kept in the same E.164 form Twilio sends.
export default function BlocklistScreen() {
  const t = useTheme();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCallBlocklist()
      .then((list) => {
        setSaved(list);
        setNumbers(list);
      })
      .catch(() => setError("Couldn't load the blocklist."));
  }, []);

  const dirty = saved !== null && (saved.length !== numbers.length || saved.some((n, i) => n !== numbers[i]));

  function add() {
    const raw = entry.trim();
    if (!raw) return;
    // Accept "0400 123 456" and store "+61400123456" -- what Twilio actually reports as the caller,
    // and what the IVR compares against literally.
    const number = toE164(raw) || raw;
    if (numbers.includes(number)) {
      Alert.alert("Already blocked", `${number} is already on the list.`);
      setEntry("");
      return;
    }
    setNumbers([...numbers, number]);
    setEntry("");
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await setCallBlocklist(numbers);
      setSaved(numbers);
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (saved === null) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Group title="Add a number" footer="Australian numbers are converted to +61 form. Blocked callers are hung up on before anyone's phone rings.">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={entry}
              onChangeText={setEntry}
              onSubmitEditing={add}
              placeholder="0400 123 456"
              placeholderTextColor={t.colors.labelTertiary}
              keyboardType="phone-pad"
              returnKeyType="done"
              style={{ flex: 1, color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
            <Pressable onPress={add} hitSlop={8} accessibilityRole="button" accessibilityLabel="Add number">
              <Icon name="plus.circle.fill" fallback="add-circle" size={26} color={t.colors.accent} />
            </Pressable>
          </View>
        </Group>

        <Group title={`Blocked (${numbers.length})`}>
          {numbers.length === 0 ? (
            <View style={{ paddingHorizontal: 14, paddingVertical: 14 }}>
              <Text style={[type.body, { color: t.colors.labelTertiary }]}>No numbers are blocked.</Text>
            </View>
          ) : (
            numbers.map((n) => (
              <View key={n} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>{n}</Text>
                <Pressable
                  onPress={() => setNumbers(numbers.filter((x) => x !== n))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Unblock ${n}`}
                >
                  <Icon name="minus.circle.fill" fallback="remove-circle" size={22} color={t.colors.danger} />
                </Pressable>
              </View>
            ))
          )}
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={saving ? "Saving…" : dirty ? "Save Blocklist" : "Saved"}
            onPress={save}
            disabled={!dirty}
            busy={saving}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
