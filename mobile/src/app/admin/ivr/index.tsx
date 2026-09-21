import React, { useCallback, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable, ActivityIndicator, Alert } from "react-native";
import { normalizeFlowName } from "../../../lib/ivr";
import { router, useFocusEffect } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group } from "../../../components/ui/Grouped";
import { Icon } from "../../../components/ui/Icon";
import { getIvrFlow, getIvrFlows, putIvrFlow, type IvrFlowSummary } from "../../../lib/api";
import {
  IVR_NODE_TYPES,
  NODE_TYPE_LABELS,
  addStepTo,
  incompleteReason,
  newNodeId,
  nodeSummary,
  nodeTitle,
  orderNodes,
  type IvrFlow,
  type IvrNodeType,
} from "../../../lib/ivr";
import { useTheme, type } from "../../../theme/theme";

const DEFAULT_FLOW = "main";

// The phone menu, as a LIST rather than the web editor's node canvas.
//
// The list is in the order a CALL walks the flow (orderNodes), not the order D1 returns rows -- in
// the real production flow those differ enough that the raw order shows the after-hours voicemail
// above the step that greets the caller. Unreachable steps are listed separately rather than
// hidden: an orphan is nearly always a half-finished edit, and it is what you came here to find.
//
// Since migration 0041 there is more than one menu to show: each phone number can route into its
// own. The switcher below picks which -- without it, a number could be pointed at a menu on this
// handset that only the web editor could then change, which is the "shipped on one surface only"
// half-feature this file's own history warns about.
export default function IvrFlowScreen() {
  const t = useTheme();
  const [flow, setFlow] = useState<IvrFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flowName, setFlowName] = useState(DEFAULT_FLOW);
  const [flows, setFlows] = useState<IvrFlowSummary[]>([]);
  const [switching, setSwitching] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(() => {
    // Never throws: a failed list leaves the switcher offering only the menu already open, which is
    // strictly better than blocking the screen everyone actually came here to use.
    getIvrFlows()
      .then(setFlows)
      .catch(() => {});
    getIvrFlow(flowName)
      .then((f) => {
        // Clear it on success, or a single failed load (one bar of signal) wins for the life of
        // the screen: the error branch returns before the data branch, so a later focus reload
        // fetches fine and repaints nothing, and backing out entirely is the only way through.
        setError(null);
        setFlow(f);
      })
      .catch(() => setError("Couldn't load the phone menu."));
  }, [flowName]);

  useFocusEffect(useCallback(() => load(), [load]));

  async function addStep(nodeType: IvrNodeType) {
    if (!flow || busy) return;
    setBusy(true);
    const id = newNodeId();
    // A new step is saved immediately rather than held locally, so its editor can load the flow
    // fresh like every other screen -- and so a half-added step can never be lost by navigating.
    try {
      await addStepTo(flow, flowName, nodeType, id, {
        get: () => getIvrFlow(flowName),
        put: (f) => putIvrFlow(flowName, f),
      });
      setAdding(false);
      openStep(id);
    } catch (e) {
      Alert.alert("Couldn't add the step", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // The step editor PUTs the whole flow back under this name, so the menu being viewed has to
  // travel with the push -- a step opened without it would save into "main".
  function openStep(id: string) {
    router.push({ pathname: "/admin/ivr/[nodeId]", params: { nodeId: id, flow: flowName } });
  }

  // A menu is not a row in a table -- it exists as soon as a step is saved under its name. So
  // "creating" one is just switching to a name that has none yet and adding the first step, which
  // `addStepTo` makes the starting step. Without this the feature needed someone to type a URL into
  // the web editor, which is not a thing to ask of a phone.
  //
  // An inline field rather than `Alert.prompt`, which exists on iOS ONLY -- the trap this file's
  // neighbours keep hitting with SF Symbols. On Android it is simply absent at runtime, so creating
  // a menu would have been impossible on exactly the platform nobody tests on.
  function newMenu() {
    const name = normalizeFlowName(newName);
    if (!name) {
      Alert.alert("Pick a name", "Use letters, numbers or underscores — for example, sales.");
      return;
    }
    setNewName("");
    setSwitching(false);
    setFlow(null);
    setFlowName(name);
  }

  const switcher = (
      <Group
        title="Menu"
        footer="Each phone number can route into its own menu — set which in Admin > Phone Numbers."
      >
        <Pressable
          onPress={() => setSwitching((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12 }}
        >
          <Text style={[type.body, { color: t.colors.label }]}>{flowName}</Text>
          <Icon
            name={switching ? "chevron.up" : "chevron.down"}
            fallback={switching ? "chevron-up" : "chevron-down"}
            size={12}
            color={t.colors.labelTertiary}
          />
        </Pressable>
        {switching
          ? flows.map((f) => (
              <Pressable
                key={f.flow}
                onPress={() => {
                  setSwitching(false);
                  if (f.flow === flowName) return;
                  // Blank the list first: without this the previous menu's steps stay on screen
                  // under the new menu's name until the fetch lands, and tapping one would open a
                  // step that is not in it.
                  setFlow(null);
                  setFlowName(f.flow);
                }}
                style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10 }}
              >
                {f.flow === flowName ? (
                  <Icon name="checkmark" fallback="checkmark" size={14} color={t.colors.accent} />
                ) : null}
                <Text style={[type.body, { color: t.colors.label, marginLeft: f.flow === flowName ? 8 : 22 }]}>
                  {f.hasEntry ? f.flow : `${f.flow} — no starting step`}
                </Text>
              </Pressable>
            ))
          : null}
        {switching ? (
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 10, gap: 8 }}>
            <Icon name="plus.circle.fill" fallback="add-circle" size={16} color={t.colors.accent} />
            <TextInput
              value={newName}
              onChangeText={setNewName}
              onSubmitEditing={newMenu}
              placeholder="New menu name"
              placeholderTextColor={t.colors.labelTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              style={{ flex: 1, color: t.colors.label, fontSize: 17, paddingVertical: 4 }}
            />
            <Pressable onPress={newMenu} disabled={!newName.trim()}>
              <Text style={[type.body, { color: newName.trim() ? t.colors.accent : t.colors.labelTertiary }]}>Create</Text>
            </Pressable>
          </View>
        ) : null}
      </Group>
    );

  if (error) {
    return (
      <Screen>
        <Text style={[type.body, { color: t.colors.labelSecondary, padding: 16 }]}>{error}</Text>
      </Screen>
    );
  }
  if (!flow) {
    return (
      <Screen>
        <ActivityIndicator color={t.colors.accent} style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  const { ordered, unreachable } = orderNodes(flow);

  const stepRow = (
    nodeId: string,
    title: string,
    summary: string,
    isEntry: boolean,
    last: boolean,
    incomplete: string | null
  ) => (
    <Pressable
      key={nodeId}
      onPress={() => openStep(nodeId)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderBottomWidth: last ? 0 : 0.5,
        borderBottomColor: t.colors.separator,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: t.colors.label }]}>
          {title}
          {isEntry ? "  ·  calls start here" : ""}
        </Text>
        <Text style={[type.footnote, { color: t.colors.labelSecondary, marginTop: 2 }]}>{summary}</Text>
        {/* A step is allowed to be half-wired -- that is how a menu gets built -- but a call
            reaching an unfinished one is told "we're experiencing a technical issue" and hung up
            on. Saying so here is what makes the permissive save safe. */}
        {incomplete ? (
          <Text style={[type.footnote, { color: t.colors.warning, marginTop: 2 }]}>
            Unfinished — {incomplete}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron.right" fallback="chevron-forward" size={16} color={t.colors.labelTertiary} />
    </Pressable>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {switcher}
        <Group
          title="The call, step by step"
          footer="Listed in the order a call walks them. Tap a step to change what it says or where it goes next."
        >
          {ordered.length === 0 ? (
            <View style={{ padding: 14 }}>
              <Text style={[type.body, { color: t.colors.labelTertiary }]}>
                {flow.nodes.length === 0
                  ? "This menu is empty. Add a step and it becomes where calls start."
                  : "No step is marked as the start of this menu, so no call can be routed. Add a step — the first one added becomes the start."}
              </Text>
            </View>
          ) : (
            ordered.map((n, i) => stepRow(n.id, nodeTitle(n), nodeSummary(n), n.isEntry, i === ordered.length - 1, incompleteReason(n)))
          )}
        </Group>

        {unreachable.length > 0 ? (
          <Group
            title="Not reachable"
            footer="No step leads here, so a call can never arrive. Usually a half-finished edit — wire it up or delete it."
          >
            {unreachable.map((n, i) => stepRow(n.id, nodeTitle(n), nodeSummary(n), false, i === unreachable.length - 1, incompleteReason(n)))}
          </Group>
        ) : null}

        {adding ? (
          <Group title="Add a step">
            {IVR_NODE_TYPES.map((nodeType, i) => (
              <Pressable
                key={nodeType}
                onPress={() => addStep(nodeType)}
                disabled={busy}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  opacity: busy ? 0.5 : 1,
                  borderBottomWidth: i === IVR_NODE_TYPES.length - 1 ? 0 : 0.5,
                  borderBottomColor: t.colors.separator,
                }}
              >
                <Icon name="plus.circle.fill" fallback="add-circle" size={18} color={t.colors.accent} />
                <Text style={[type.body, { color: t.colors.label, marginLeft: 10 }]}>{NODE_TYPE_LABELS[nodeType]}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setAdding(false)} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={[type.body, { color: t.colors.labelSecondary }]}>Cancel</Text>
            </Pressable>
          </Group>
        ) : (
          <Group>
            <Pressable
              onPress={() => setAdding(true)}
              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 }}
            >
              <Icon name="plus.circle.fill" fallback="add-circle" size={18} color={t.colors.accent} />
              <Text style={[type.body, { color: t.colors.accent, marginLeft: 10 }]}>Add a step</Text>
            </Pressable>
          </Group>
        )}

        <Group footer="Changes are live the moment they save — the next caller hears them. The web editor at tcbvoip.app draws the same flow as a diagram, which is easier for a big rearrangement.">
          <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            <Text style={[type.footnote, { color: t.colors.labelSecondary }]}>
              Uploading new recordings is still web-only. Text-to-speech prompts can be edited here.
            </Text>
          </View>
        </Group>
      </ScrollView>
    </Screen>
  );
}
