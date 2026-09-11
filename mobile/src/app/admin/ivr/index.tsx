import React, { useCallback, useState } from "react";
import { ScrollView, View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Screen } from "../../../components/ui/Screen";
import { Group } from "../../../components/ui/Grouped";
import { Icon } from "../../../components/ui/Icon";
import { getIvrFlow, putIvrFlow } from "../../../lib/api";
import {
  IVR_NODE_TYPES,
  NODE_TYPE_LABELS,
  blankConfigFor,
  incompleteReason,
  newNodeId,
  nodeSummary,
  nodeTitle,
  orderNodes,
  type IvrFlow,
  type IvrNodeType,
} from "../../../lib/ivr";
import { useTheme, type } from "../../../theme/theme";

const FLOW = "main";

// The phone menu, as a LIST rather than the web editor's node canvas.
//
// The list is in the order a CALL walks the flow (orderNodes), not the order D1 returns rows -- in
// the real production flow those differ enough that the raw order shows the after-hours voicemail
// above the step that greets the caller. Unreachable steps are listed separately rather than
// hidden: an orphan is nearly always a half-finished edit, and it is what you came here to find.
export default function IvrFlowScreen() {
  const t = useTheme();
  const [flow, setFlow] = useState<IvrFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getIvrFlow(FLOW)
      .then((f) => {
        // Clear it on success, or a single failed load (one bar of signal) wins for the life of
        // the screen: the error branch returns before the data branch, so a later focus reload
        // fetches fine and repaints nothing, and backing out entirely is the only way through.
        setError(null);
        setFlow(f);
      })
      .catch(() => setError("Couldn't load the phone menu."));
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  async function addStep(nodeType: IvrNodeType) {
    if (!flow || busy) return;
    setBusy(true);
    const id = newNodeId();
    // A new step is saved immediately rather than held locally, so its editor can load the flow
    // fresh like every other screen -- and so a half-added step can never be lost by navigating.
    const next: IvrFlow = {
      ...flow,
      nodes: [...flow.nodes, { id, flow: FLOW, isEntry: false, type: nodeType, config: blankConfigFor(nodeType), positionX: null, positionY: null }],
    };
    try {
      await putIvrFlow(FLOW, next);
      setAdding(false);
      router.push(`/admin/ivr/${id}`);
    } catch (e) {
      Alert.alert("Couldn't add the step", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

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
      onPress={() => router.push(`/admin/ivr/${nodeId}`)}
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
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group
          title="The call, step by step"
          footer="Listed in the order a call walks them. Tap a step to change what it says or where it goes next."
        >
          {ordered.length === 0 ? (
            <View style={{ padding: 14 }}>
              <Text style={[type.body, { color: t.colors.labelTertiary }]}>
                No step is marked as the start of the flow, so no call can be routed. Fix this on the web editor.
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
