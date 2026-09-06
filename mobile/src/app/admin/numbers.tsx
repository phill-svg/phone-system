import React, { useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, ActivityIndicator, Alert } from "react-native";
import { Screen } from "../../components/ui/Screen";
import { Group, Row } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Segmented } from "../../components/ui/Segmented";
import {
  getNumbers,
  createNumber,
  updateNumber,
  deleteNumber,
  type PhoneNumber,
  type PhoneNumberInput,
} from "../../lib/api";
import { toE164 } from "../../lib/phone";
import { useTheme, type } from "../../theme/theme";

type Region = "au1" | "us1";

const BLANK: PhoneNumberInput = {
  e164: "",
  label: "",
  voice_enabled: false,
  sms_enabled: false,
  is_default_voice: false,
  is_default_sms: false,
  region: "au1",
};

function toInput(n: PhoneNumber): PhoneNumberInput {
  return {
    e164: n.e164,
    label: n.label,
    voice_enabled: !!n.voice_enabled,
    sms_enabled: !!n.sms_enabled,
    is_default_voice: !!n.is_default_voice,
    is_default_sms: !!n.is_default_sms,
    region: n.region,
  };
}

// The business's sending numbers — what staff see in the "Call from" and "From" pickers.
//
// Adding a row here configures NOTHING on Twilio: the number must already exist and be wired up
// there, and inbound routing never reads this table. What it does record is the region, which is
// worth getting right — see the warning below.
export default function NumbersScreen() {
  const t = useTheme();
  const [numbers, setNumbers] = useState<PhoneNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PhoneNumberInput>(BLANK);

  async function load() {
    try {
      setNumbers(await getNumbers());
    } catch {
      setError("Couldn't load the phone numbers.");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    const e164 = toE164(draft.e164);
    if (!e164 || !draft.label.trim() || adding) {
      Alert.alert("Add a number", "Enter the number and a label staff will recognise.");
      return;
    }
    setAdding(true);
    try {
      await createNumber({ ...draft, e164 });
      setDraft(BLANK);
      await load();
    } catch (e) {
      Alert.alert("Couldn't add", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setAdding(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (numbers === null) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {numbers.map((n) => (
          <NumberCard key={n.id} number={n} onChanged={load} />
        ))}

        <Group
          title="Add a number"
          footer="The number must already be set up in Twilio — adding it here only puts it in the staff pickers."
        >
          <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 10 }}>
            <TextInput
              value={draft.e164}
              onChangeText={(v) => setDraft({ ...draft, e164: v })}
              placeholder="+61…"
              placeholderTextColor={t.colors.labelTertiary}
              keyboardType="phone-pad"
              style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
            <TextInput
              value={draft.label}
              onChangeText={(v) => setDraft({ ...draft, label: v })}
              placeholder="Label staff see"
              placeholderTextColor={t.colors.labelTertiary}
              style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
            />
          </View>
          <Row label="Voice" toggle={draft.voice_enabled} onToggle={(v) => setDraft({ ...draft, voice_enabled: v })} />
          <Row label="SMS" toggle={draft.sms_enabled} onToggle={(v) => setDraft({ ...draft, sms_enabled: v })} />
          <RegionPicker value={(draft.region as Region) ?? "au1"} onChange={(r) => setDraft({ ...draft, region: r })} />
        </Group>

        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <PrimaryButton label={adding ? "Adding…" : "Add Number"} onPress={add} busy={adding} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function NumberCard({ number, onChanged }: { number: PhoneNumber; onChanged: () => void }) {
  const t = useTheme();
  const [input, setInput] = useState<PhoneNumberInput>(toInput(number));
  const [saving, setSaving] = useState(false);

  useEffect(() => setInput(toInput(number)), [number]);

  const dirty = JSON.stringify(input) !== JSON.stringify(toInput(number));
  // The trap that cost a day when the landline ported in on us1: a voice number is processed in
  // whichever region its Twilio config names, softphone clients only register in au1, and Twilio
  // will not connect an SDK client to a call processed elsewhere. Recording it here doesn't fix
  // Twilio's side — it makes the mismatch visible so someone goes and fixes it in the console.
  const wrongRegion = input.voice_enabled && input.region !== "au1";

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await updateNumber(number.id, input);
      onChanged();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    Alert.alert("Remove number?", `${number.e164} will disappear from the staff pickers. Nothing changes in Twilio.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteNumber(number.id);
            onChanged();
          } catch (e) {
            Alert.alert("Couldn't remove", e instanceof Error ? e.message : "Try again in a moment.");
          }
        },
      },
    ]);
  }

  return (
    <Group title={number.e164} footer={wrongRegion ? "This number takes voice calls but isn't in au1, so the softphone can't be connected to them. Fix it on the number's Regional tab in the Twilio console." : undefined}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
        <TextInput
          value={input.label}
          onChangeText={(v) => setInput({ ...input, label: v })}
          placeholder="Label staff see"
          placeholderTextColor={t.colors.labelTertiary}
          style={{ color: t.colors.label, fontSize: 17, paddingVertical: 6 }}
        />
      </View>
      <Row label="Voice" toggle={input.voice_enabled} onToggle={(v) => setInput({ ...input, voice_enabled: v })} />
      <Row label="SMS" toggle={input.sms_enabled} onToggle={(v) => setInput({ ...input, sms_enabled: v })} />
      <Row label="Default for calls" toggle={input.is_default_voice} onToggle={(v) => setInput({ ...input, is_default_voice: v })} />
      <Row label="Default for texts" toggle={input.is_default_sms} onToggle={(v) => setInput({ ...input, is_default_sms: v })} />
      <RegionPicker value={(input.region as Region) ?? "au1"} onChange={(r) => setInput({ ...input, region: r })} />
      {wrongRegion ? (
        <Row icon="exclamationmark.triangle.fill" iconColor={t.colors.warning} label="Voice number is not in au1" />
      ) : null}
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 12 }}>
        <View style={{ flex: 1 }}>
          <PrimaryButton label={saving ? "Saving…" : dirty ? "Save" : "Saved"} onPress={save} disabled={!dirty} busy={saving} />
        </View>
        <View style={{ flex: 1 }}>
          <PrimaryButton label="Remove" onPress={confirmDelete} destructive />
        </View>
      </View>
    </Group>
  );
}

function RegionPicker({ value, onChange }: { value: Region; onChange: (r: Region) => void }) {
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
      <Segmented<Region>
        options={[
          { label: "au1 (Australia)", value: "au1" },
          { label: "us1 (US)", value: "us1" },
        ]}
        value={value}
        onChange={onChange}
      />
    </View>
  );
}
