import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, ActivityIndicator, Alert } from "react-native";
import { Screen } from "../../components/ui/Screen";
import { Group, Row } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { getMissedCallSmsSetting, setMissedCallSmsSetting, type MissedCallSmsSetting, ApiError } from "../../lib/api";
import { useTheme, type } from "../../theme/theme";

// Matches src/api/settings.ts's MAX_MISSED_CALL_SMS_TEMPLATE -- an SMS bills per ~160 (GSM-7)
// characters, so this is the mobile half of the same "don't let a template bill for a novel"
// guard the server enforces regardless of which client sends it.
const MAX_TEMPLATE = 320;

export default function MissedCallSmsScreen() {
  const t = useTheme();
  const [saved, setSaved] = useState<MissedCallSmsSetting | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMissedCallSmsSetting()
      .then((s) => {
        setSaved(s);
        setEnabled(s.enabled);
        setTemplate(s.template);
      })
      .catch(() => setError("Couldn't load this setting."));
  }, []);

  const dirty = saved !== null && (saved.enabled !== enabled || saved.template !== template);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const value = { enabled, template };
      await setMissedCallSmsSetting(value);
      setSaved(value);
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof ApiError ? e.message : "Check your connection and try again.");
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
        <Group
          title="Auto Missed-Call SMS"
          footer="When a call rings out with nobody answering, automatically text the caller from the business number. This fires once the call is fully over -- a caller who gets through on a second ring round is never texted mid-conversation -- and only for a call that actually reached a ring (a wrong number who hangs up during the greeting is not counted)."
        >
          <Row icon="message.fill" iconFallback="chatbubble" iconColor="#34C759" label="Send an automatic text on a missed call"
            toggle={enabled} onToggle={setEnabled} />
        </Group>

        <Group title="Message" footer={`${template.length}/${MAX_TEMPLATE} characters`}>
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <TextInput
              value={template}
              onChangeText={(v) => setTemplate(v.slice(0, MAX_TEMPLATE))}
              placeholder="Sorry we missed your call! We'll call you back as soon as we can."
              placeholderTextColor={t.colors.labelTertiary}
              multiline
              style={[type.body, { color: t.colors.label, paddingVertical: 6, minHeight: 80, textAlignVertical: "top" }]}
            />
          </View>
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton
            label={saving ? "Saving…" : dirty ? "Save" : "Saved"}
            onPress={save}
            disabled={!dirty}
            busy={saving}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
