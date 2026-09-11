import React, { useCallback, useRef, useState } from "react";
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
  configsEqual,
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

// A whole-number field you can actually CLEAR.
//
// The old version was `Number(text.replace(/\D/g, "")) || 0` straight into the draft, so
// backspacing the box snapped it to "0" and it could never be empty. That is not cosmetic:
// `numDigits` is passed to <Gather> verbatim by the flow engine, and `isInputConfig` only checks
// `typeof === "number"` -- so clearing the field intending to retype it, then tapping Save, built
// a live Gather asking for zero digits.
//
// The box therefore owns its own text and the parent keeps the last valid number. While the text
// is empty nothing is committed, which is exactly "clear it, type the new one".
//
// `min` is 0 or 1 ONLY, and that bound is load-bearing rather than incidental. A higher floor would
// let the committed value diverge from what the box shows -- type "3" into a min-5 field and it
// commits 5 while reading 3 -- and the enclosing ScrollView sets keyboardShouldPersistTaps="handled",
// so a tap on Save never blurs the field and never reconciles the two. That is the same trap
// recorded for TimeField, and the fix is to make the clamp unreachable during ordinary typing: with
// a floor of 1, every digit string except "0" is already at or above it, so Math.max only ever fires
// on a lone zero -- which is the one value that must not reach a live <Gather>.
// Per-field because zero retries is a legitimate answer and zero digits is not.
function NumberField({
  label,
  placeholder,
  min,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  min: number;
  value: number;
  onCommit: (n: number) => void;
}) {
  const t = useTheme();
  const [text, setText] = useState(String(value));
  // Ignore the parent echoing back what we just sent; re-seed only on a genuine outside change
  // (a reload). Same trap as the schedule editor's TimeField: without it a commit rewrites the box
  // mid-word.
  const pushed = useRef(String(value));
  if (String(value) !== pushed.current) {
    pushed.current = String(value);
    setText(String(value));
  }

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}>
      <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, "");
          setText(digits);
          if (digits === "") return;
          const n = Math.max(min, Number(digits));
          pushed.current = String(n);
          onCommit(n);
        }}
        onBlur={() => setText(pushed.current)}
        placeholder={placeholder}
        placeholderTextColor={t.colors.labelTertiary}
        keyboardType="number-pad"
        style={[type.body, { color: t.colors.label, paddingVertical: 6 }]}
      />
    </View>
  );
}

export default function IvrNodeScreen() {
  const t = useTheme();
  const { nodeId } = useLocalSearchParams<{ nodeId: string }>();
  const [flow, setFlow] = useState<IvrFlow | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [audio, setAudio] = useState<IvrAudioAsset[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPicker, setOpenPicker] = useState<string | null>(null);

  // `keepEdits` is what stops a reload discarding what you have typed. load() runs on every screen
  // FOCUS, not just on mount, and an incoming call pushes /call-incoming as a root-stack modal from
  // anywhere in the app -- so without this, typing a new greeting, taking a call and coming back
  // replaced the draft with the server's copy. There is no dirty indicator here, so nothing would
  // have said it had gone. `on-call.tsx` solved exactly this; `business-hours.tsx` sidesteps it
  // with a mount-only effect.
  const load = useCallback(
    (keepEdits = false) => {
      getIvrFlow(FLOW)
        .then((f) => {
          const node = f.nodes.find((n) => n.id === nodeId);
          if (!node) {
            setError("That step no longer exists.");
            return;
          }
          // Cleared on success, or one failed load pins the error screen for the life of the
          // component: the error branch returns before the data branch, so every later load
          // succeeds and repaints nothing.
          setError(null);
          setFlow(f);
          if (!keepEdits) setDraft({ ...node.config });
        })
        .catch(() => setError("Couldn't load the phone menu."));
      getIvrAudio()
        .then(setAudio)
        .catch(() => {});
    },
    [nodeId]
  );

  const node: IvrNode | undefined = flow?.nodes.find((n) => n.id === nodeId);

  // Declared ABOVE the focus effect that reads it -- useFocusEffect defers its body, so the order
  // happens to work, but anything running the callback during render would hit the temporal dead
  // zone and blank the screen.
  const dirtyRef = useRef(false);
  dirtyRef.current = draft !== null && node !== undefined && !configsEqual(draft, node.config);

  useFocusEffect(
    useCallback(() => {
      load(dirtyRef.current);
    }, [load])
  );

  function set(key: string, value: unknown) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save() {
    if (!flow || !node || !draft || saving) return;
    setSaving(true);
    try {
      // Re-read the flow immediately before writing, and apply the draft to THAT copy. The
      // endpoint is a whole-flow delete-and-reinsert with no version check, and this screen's
      // snapshot is as old as the time spent typing -- so writing the snapshot back would revert
      // anything changed in the web editor meanwhile, silently, while the phone reported success.
      // This does not make the write atomic; it narrows the window from minutes to milliseconds.
      // A failed re-read falls back to the snapshot rather than refusing: the point of reading is
      // to avoid clobbering someone else's edit, and turning a transient GET failure into "you
      // cannot save" would block a write the PUT would have accepted.
      const fresh = await getIvrFlow(FLOW).catch(() => flow);
      if (!fresh.nodes.some((n) => n.id === node.id)) {
        Alert.alert("Couldn't save", "That step has been deleted somewhere else.");
        return;
      }
      // The whole flow goes back, every other node byte-for-byte as it arrived -- positions
      // included. The endpoint is a delete-and-reinsert, so anything omitted is destroyed.
      await putIvrFlow(FLOW, {
        ...fresh,
        nodes: fresh.nodes.map((n) => (n.id === node.id ? { ...n, config: draft } : n)),
      });
      router.back();
    } catch (e) {
      // The API names the offending node and field (a bad closed date, a missing key) in a JSON
      // {error} body that apiFetch lifts out, so this really is the server's message and not
      // "request failed (400)" -- it answered in plain text until the fixes over #91.
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  function confirmUseText() {
    Alert.alert(
      "Replace the recording with text?",
      "This step will read out typed words instead of playing the recording. Choosing a recording again is web-only, so you won't be able to undo this from your phone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Use text", style: "destructive", onPress: () => set("audioAssetId", null) },
      ]
    );
  }

  function confirmDelete() {
    if (!flow || !node) return;
    // The entry step cannot be deleted from here, and saying so beats the old dialog, which
    // explained what would happen and then 400d: removeNode returns entryNodeId null, and the
    // endpoint requires a string matching exactly one node. Choosing the replacement start is the
    // real work and there is no "set as start" control on this screen, so it belongs on the web.
    if (node.isEntry) {
      Alert.alert(
        "This is where calls start",
        "Every call begins at this step, so it can't be deleted from here — something has to take its place first. Pick a new starting step in the web editor, then come back."
      );
      return;
    }
    Alert.alert(
      "Delete this step?",
      // Not "fall through": a blank next-field throws in the flow engine exactly as a dangling id
      // does, and the caller is told "we're experiencing a technical issue" and hung up on. The
      // list screen marks the unwired steps so they are findable afterwards.
      "Any step pointing here will be left unwired. A call reaching one of those is cut off, so check the list for steps marked unfinished afterwards.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSaving(true);
            try {
              // Re-read for the same reason save() does, and more urgently: removeNode carries
              // `entryNodeId` forward from whatever it is handed, so deleting from a stale snapshot
              // reverts every web edit made since this screen opened -- entry node included --
              // while reporting success.
              const fresh = await getIvrFlow(FLOW).catch(() => flow);
              const current = fresh.nodes.find((n) => n.id === node.id);
              if (!current) {
                router.back();
                return;
              }
              // Re-checked against the FRESH copy: the entry could have moved to this step on the
              // web since the screen opened, and deleting it then would quietly change where every
              // call starts.
              if (current.isEntry || fresh.entryNodeId === current.id) {
                Alert.alert(
                  "This is where calls start",
                  "This step became the starting step since you opened it, so it can't be deleted from here."
                );
                return;
              }
              await putIvrFlow(FLOW, removeNode(fresh, node.id));
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

  const textField = (key: string, label: string, placeholder: string) => (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: t.colors.separator }}>
      <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>{label}</Text>
      <TextInput
        value={String(draft[key] ?? "")}
        onChangeText={(v) => set(key, v)}
        placeholder={placeholder}
        placeholderTextColor={t.colors.labelTertiary}
        keyboardType={undefined}
        multiline={key === "ttsText"}
        style={[type.body, { color: t.colors.label, paddingVertical: 6 }]}
      />
    </View>
  );

  const numberField = (key: string, label: string, placeholder: string, min: number) => (
    <NumberField
      key={key}
      label={label}
      placeholder={placeholder}
      min={min}
      value={typeof draft[key] === "number" ? (draft[key] as number) : min}
      onCommit={(n) => set(key, n)}
    />
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
                {/* Confirmed, because this is one tap away from silencing a live step and the way
                    back is not on this phone: uploading or re-picking a recording is web-only, and
                    a step with neither a recording nor spoken text says NOTHING to the caller. */}
                <Pressable onPress={confirmUseText} hitSlop={8}>
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

        {node.type === "input" ? <Group>{numberField("numDigits", "Digits to collect", "1", 1)}</Group> : null}

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
            {numberField("timeoutSeconds", "Ring for (seconds)", "20", 1)}
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
            {numberField("retryLimit", "Wrong keys allowed", "1", 0)}
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
            {/* "Not set" belongs here as much as on the general picker. Adding and removing a key
                is deliberately web-only, but UNWIRING one is a different thing -- without this a
                key pointing at the wrong step could be re-pointed and never cleared. */}
            <Pressable
              onPress={() => {
                const next = [...options];
                next[index] = { ...opt, nextNodeId: "" };
                set("options", next);
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
