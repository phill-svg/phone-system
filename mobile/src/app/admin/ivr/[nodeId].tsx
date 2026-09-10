import React, { useCallback, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable, ActivityIndicator, Alert, Switch } from "react-native";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group } from "../../../components/ui/Grouped";
import { PrimaryButton } from "../../../components/ui/PrimaryButton";
import { Icon } from "../../../components/ui/Icon";
import { getIvrAudio, getIvrFlow, putIvrFlow, type IvrAudioAsset } from "../../../lib/api";
import {
  NEXT_FIELDS,
  NEXT_FIELD_LABELS,
  NODE_TYPE_LABELS,
  nodePickerLabel,
  nodeTitle,
  removeNode,
  type IvrFlow,
  type IvrNode,
} from "../../../lib/ivr";
import { useTheme, type } from "../../../theme/theme";

const FLOW = "main";

// Types whose caller-facing prompt is editable here. Voicemail and callback have one too, so the
// list is "everything except the pure branching and routing steps".
const HAS_PROMPT = new Set(["play", "gather", "input", "wait", "voicemail", "callback"]);

export default function IvrNodeScreen() {
  const t = useTheme();
  const { nodeId } = useLocalSearchParams<{ nodeId: string }>();
  const [flow, setFlow] = useState<IvrFlow | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [audio, setAudio] = useState<IvrAudioAsset[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<string | null>(null);

  const load = useCallback(() => {
    getIvrFlow(FLOW)
      .then((f) => {
        const node = f.nodes.find((n) => n.id === nodeId);
        if (!node) {
          setError("That step no longer exists.");
          return;
        }
        setFlow(f);
        setDraft({ ...node.config });
      })
      .catch(() => setError("Couldn't load the phone menu."));
    getIvrAudio()
      .then(setAudio)
      .catch(() => {});
  }, [nodeId]);

  useFocusEffect(useCallback(() => load(), [load]));

  const node: IvrNode | undefined = flow?.nodes.find((n) => n.id === nodeId);

  function set(key: string, value: unknown) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save() {
    if (!flow || !node || !draft || saving) return;
    setSaving(true);
    try {
      // The whole flow goes back, every other node byte-for-byte as it arrived -- positions
      // included. The endpoint is a delete-and-reinsert, so anything omitted is destroyed.
      await putIvrFlow(FLOW, {
        ...flow,
        nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, config: draft } : n)),
      });
      router.back();
    } catch (e) {
      // The API names the offending node and field (a bad closed date, a missing key), and that
      // message is the whole point of validating on write -- so show it rather than "failed".
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!flow || !node) return;
    Alert.alert(
      "Delete this step?",
      node.isEntry
        ? "This is where calls start. Deleting it leaves the flow with no entry point, and no call can be routed until you set one on the web editor."
        : "Any step pointing here will be left unwired, and callers reaching that point will fall through.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSaving(true);
            try {
              await putIvrFlow(FLOW, removeNode(flow, node.id));
              router.back();
            } catch (e) {
              Alert.alert("Couldn't delete", e instanceof Error ? e.message : "Try again in a moment.");
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  }

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (!flow || !node || !draft) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  const others = flow.nodes.filter((n) => n.id !== node.id);
  const nameOf = (id: unknown) => {
    const target = flow.nodes.find((n) => n.id === id);
    return target ? nodePickerLabel(target) : "Not set — callers fall through";
  };

  // A "go to" field. Expands in place rather than pushing a picker screen: the list is short, and
  // a modal would lose the surrounding context of what you are wiring.
  const gotoField = (key: string, label: string) => (
    <View key={key}>
      <Pressable
        onPress={() => setOpenPicker(openPicker === key ? null : key)}
        style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}
      >
        <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{label}</Text>
        <Text style={[type.body, { color: draft[key] ? t.colors.label : t.colors.accent, marginTop: 2 }]}>{nameOf(draft[key])}</Text>
      </Pressable>
      {openPicker === key ? (
        <View style={{ backgroundColor: t.colors.bg }}>
          <Pressable
            onPress={() => {
              set(key, "");
              setOpenPicker(null);
            }}
            style={{ paddingHorizontal: 24, paddingVertical: 10 }}
          >
            <Text style={[type.body, { color: t.colors.labelSecondary }]}>Not set</Text>
          </Pressable>
          {others.map((o) => (
            <Pressable
              key={o.id}
              onPress={() => {
                set(key, o.id);
                setOpenPicker(null);
              }}
              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10 }}
            >
              {draft[key] === o.id ? <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} /> : null}
              <Text style={[type.body, { color: t.colors.label, marginLeft: draft[key] === o.id ? 8 : 22 }]}>{nodePickerLabel(o)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );

  const textField = (key: string, label: string, placeholder: string, keyboardType?: "number-pad") => (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}>
      <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{label}</Text>
      <TextInput
        value={String(draft[key] ?? "")}
        onChangeText={(v) => set(key, keyboardType === "number-pad" ? Number(v.replace(/\D/g, "")) || 0 : v)}
        placeholder={placeholder}
        placeholderTextColor={t.colors.labelTertiary}
        keyboardType={keyboardType}
        multiline={key === "ttsText"}
        style={[type.body, { color: t.colors.label, paddingVertical: 6 }]}
      />
    </View>
  );

  const options = Array.isArray(draft.options) ? (draft.options as { digit: string; nextNodeId: string }[]) : [];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Group title={nodeTitle(node)} footer={node.isEntry ? "Calls start at this step." : undefined}>
          <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{NODE_TYPE_LABELS[node.type]}</Text>
          </View>
        </Group>

        {HAS_PROMPT.has(node.type) ? (
          <Group
            title="What the caller hears"
            footer={
              draft.audioAssetId
                ? "A recording is set, and it plays instead of any text below. Recordings are uploaded on the web editor."
                : "Left blank, this step says nothing. Uploading a recording is still web-only."
            }
          >
            {draft.audioAssetId ? (
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>
                  {audio.find((a) => a.id === draft.audioAssetId)?.label ?? "Recording"}
                </Text>
                <Pressable onPress={() => set("audioAssetId", null)} hitSlop={8}>
                  <Text style={[type.body, { color: t.colors.accent }]}>Use text</Text>
                </Pressable>
              </View>
            ) : (
              textField("ttsText", "Spoken text", "Thanks for calling TCB Pest Control…")
            )}
          </Group>
        ) : null}

        {node.type === "voicemail" ? (
          <Group footer="Names the mailbox in the Inbox, so messages from different points in the menu stay apart.">
            {textField("mailboxLabel", "Mailbox name", "After hours")}
          </Group>
        ) : null}

        {node.type === "redirect" ? <Group>{textField("number", "Forward to", "+61…")}</Group> : null}

        {node.type === "input" ? <Group>{textField("numDigits", "Digits to collect", "1", "number-pad")}</Group> : null}

        {node.type === "ring" ? (
          <Group
            title="Who rings"
            footer={
              draft.target === "on_call"
                ? "Rings the one person the weekly after-hours rotation names, on their mobile, ignoring working hours and Away status. Set the rotation under Admin → After-hours On Call."
                : "Everyone available means every staff member on shift right now. Choosing specific people is web-only."
            }
          >
            {(["all", "on_call"] as const).map((value) => (
              <Pressable
                key={value}
                onPress={() => set("target", value)}
                style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 }}
              >
                {draft.target === value ? <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} /> : null}
                <Text style={[type.body, { color: t.colors.label, marginLeft: draft.target === value ? 8 : 22 }]}>
                  {value === "all" ? "Everyone available" : "Whoever is on call"}
                </Text>
              </Pressable>
            ))}
            {Array.isArray(draft.target) ? (
              <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
                <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>
                  Currently set to {(draft.target as string[]).length} specific staff member(s). Changing that is web-only; tapping above
                  replaces it.
                </Text>
              </View>
            ) : null}
            {textField("timeoutSeconds", "Ring for (seconds)", "20", "number-pad")}
          </Group>
        ) : null}

        {node.type === "wait" ? (
          <Group footer="With this on, a caller on hold can press ★ to request a callback instead of waiting.">
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={[type.body, { color: t.colors.label, flex: 1 }]}>★ requests a callback</Text>
              <Switch value={draft.allowCallbackStar === true} onValueChange={(v) => set("allowCallbackStar", v)} />
            </View>
          </Group>
        ) : null}

        {node.type === "gather" ? (
          <Group title="Menu keys" footer="Which key sends the caller where. Adding or removing a key is web-only.">
            {options.length === 0 ? (
              <View style={{ padding: 14 }}>
                <Text style={[type.body, { color: t.colors.labelTertiary }]}>No keys set.</Text>
              </View>
            ) : (
              options.map((opt, i) =>
                gotoFieldForOption(opt, i)
              )
            )}
            {textField("retryLimit", "Wrong keys allowed", "1", "number-pad")}
          </Group>
        ) : null}

        {NEXT_FIELDS[node.type].length > 0 ? (
          <Group title="Where it goes next">
            {NEXT_FIELDS[node.type].map((field) => gotoField(field, NEXT_FIELD_LABELS[field] ?? field))}
          </Group>
        ) : null}

        <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
          <PrimaryButton label="Save step" onPress={save} disabled={saving} busy={saving} />
        </View>

        <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
          <Pressable onPress={confirmDelete} disabled={saving} style={{ paddingVertical: 12, alignItems: "center" }}>
            <Text style={[type.body, { color: t.colors.danger }]}>Delete this step</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );

  // A menu key's destination, reusing the same expanding picker. Keyed on the digit so two keys
  // pointing at the same step still open independently.
  function gotoFieldForOption(opt: { digit: string; nextNodeId: string }, index: number) {
    const key = `option:${opt.digit}`;
    return (
      <View key={key}>
        <Pressable
          onPress={() => setOpenPicker(openPicker === key ? null : key)}
          style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}
        >
          <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>Press {opt.digit}</Text>
          <Text style={[type.body, { color: opt.nextNodeId ? t.colors.label : t.colors.accent, marginTop: 2 }]}>{nameOf(opt.nextNodeId)}</Text>
        </Pressable>
        {openPicker === key ? (
          <View style={{ backgroundColor: t.colors.bg }}>
            {others.map((o) => (
              <Pressable
                key={o.id}
                onPress={() => {
                  const next = [...options];
                  next[index] = { ...opt, nextNodeId: o.id };
                  set("options", next);
                  setOpenPicker(null);
                }}
                style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10 }}
              >
                {opt.nextNodeId === o.id ? <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} /> : null}
                <Text style={[type.body, { color: t.colors.label, marginLeft: opt.nextNodeId === o.id ? 8 : 22 }]}>{nodePickerLabel(o)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );
  }
}
