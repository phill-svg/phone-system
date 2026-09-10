import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../components/ui/Screen";
import { Group } from "../../components/ui/Grouped";
import { PrimaryButton } from "../../components/ui/PrimaryButton";
import { Icon } from "../../components/ui/Icon";
import { getOnCall, setOnCallOverride, setOnCallRotation, type OnCallState } from "../../lib/api";
import { rotationMemberFor, shortName, weekLabel } from "../../lib/onCall";
import { useTheme, type } from "../../theme/theme";


export default function OnCallScreen() {
  const t = useTheme();
  const [state, setState] = useState<OnCallState | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `keepEdits` is what stops a reload discarding an unsaved reorder. load() runs on every screen
  // focus and after every week-swap, so without it: reorder, tap a week to record a swap, and the
  // reorder is silently replaced by the server's copy with the Save button vanishing behind it.
  const load = useCallback((keepEdits = false) => {
    getOnCall()
      .then((s) => {
        setState(s);
        if (!keepEdits) setMembers(s.rotation.members);
        // Cleared on success, or one flaky first load pins the error screen for the life of the
        // component -- every later load succeeds and repaints nothing, because the error branch
        // returns before the data branch is ever reached.
        setError(null);
      })
      .catch(() => setError("Couldn't load the rotation."));
  }, []);

  // Passing `dirty` through is the point: load() runs on every screen focus, so an Alert or a
  // notification tap that briefly defocuses the screen would otherwise silently discard a reorder
  // and take the Save button with it.
  useFocusEffect(
    useCallback(() => {
      load(dirtyRef.current);
    }, [load])
  );

  // Mirrored into a ref so the focus effect can read it without re-subscribing on every keystroke
  // of an edit -- the effect must not re-run just because the list changed.
  const dirtyRef = useRef(false);
  const dirty =
    state !== null &&
    (state.rotation.members.length !== members.length || state.rotation.members.some((m, i) => m !== members[i]));
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  function move(index: number, delta: number) {
    const next = [...members];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setMembers(next);
  }

  function toggleMember(email: string) {
    setMembers(members.includes(email) ? members.filter((m) => m !== email) : [...members, email]);
  }

  async function save() {
    if (saving || !state) return;

    // Preserving the anchor does not preserve who is on call tonight: the member COUNT re-indexes
    // every week, so adding or removing anyone can hand the current week to someone else, mid-week,
    // with no warning. The eight-week preview only refreshes AFTER the write, so this is the one
    // moment it can be said before it is true.
    const anchor = state.rotation.anchorWeekStart;
    const before = rotationMemberFor(state.rotation.members, anchor, state.thisWeek);
    const after = rotationMemberFor(members, anchor, state.thisWeek);
    if (before !== after) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "This changes who is on call now",
          `${before ? shortName(before) : "Nobody"} is on call this week. Saving makes it ${after ? shortName(after) : "nobody"}.`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Save anyway", style: "destructive", onPress: () => resolve(true) },
          ]
        );
      });
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      // The anchor the server sent us, unchanged. Dropping it re-anchors the rota to this week.
      await setOnCallRotation(members, state.rotation.anchorWeekStart);
      load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  // Tapping a week cycles to the next person on the roster, then round to nobody. A picker would be
  // a modal for a one-tap change; the list is short and the current value is always on screen.
  // Cycling includes `null`, which CLEARS any override and hands the week back to the rotation --
  // it does not mean "nobody covers this week". On a week the rotation covers, landing on null
  // repaints with the rotation member still there, which would read as the tap being ignored, so
  // the row says "Rotation" for a rotation-sourced week and "Nobody" only when nobody really is on
  // call. (An earlier version of this comment claimed the labels already did that when only the web
  // dropdown had been changed.)
  async function cycleWeek(weekStart: string, current: string | null) {
    if (!state) return;
    const options = [...state.staff, null];
    const at = current === null ? options.length - 1 : options.indexOf(current);
    const next = options[(at + 1) % options.length];
    try {
      await setOnCallOverride(weekStart, next);
      load(true);
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again in a moment.");
    }
  }

  // `&& !state` matters: without it a flaky reload replaces a fully loaded rota -- preview,
  // unsaved reorder and all -- with one line of text and no way back except leaving the screen.
  // A stale-but-present rota is far more useful than an error page.
  if (error && !state) {
    return (
      <Screen>
        <Text style={{ color: t.colors.labelSecondary, padding: 16 }}>{error}</Text>
      </Screen>
    );
  }
  if (!state) {
    return (
      <Screen>
        <ActivityIndicator style={{ marginTop: 32 }} />
      </Screen>
    );
  }

  const notInRotation = state.staff.filter((e) => !members.includes(e));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Group
          title="Rotation order"
          footer={
            "Outside business hours nobody is on shift, so calls go to voicemail. The rotation rings ONE person anyway — " +
            "on their mobile, ignoring their ring-my-mobile toggle and Away status, because being on call is the " +
            "commitment to be reachable. Weeks run Monday to Monday, Canberra time.\n\n" +
            "This does nothing on its own: the after-hours branch of the IVR needs a ring step set to “Whoever is on " +
            "call”, which is web-only — open tcbvoip.app on a computer."
          }
        >
          {members.length === 0 ? (
            <View style={{ padding: 14 }}>
              <Text style={{ color: t.colors.labelSecondary, ...type.body }}>
                Nobody is on call. After-hours callers go straight to voicemail.
              </Text>
            </View>
          ) : (
            members.map((email, i) => (
              <View
                key={email}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  borderBottomWidth: i === members.length - 1 ? 0 : 0.5,
                  borderBottomColor: t.colors.separator,
                }}
              >
                <Text style={{ color: t.colors.labelSecondary, width: 26, ...type.body }}>{i + 1}</Text>
                <Text style={{ color: t.colors.label, flex: 1, ...type.body }}>{email}</Text>
                <Pressable onPress={() => move(i, -1)} disabled={i === 0} hitSlop={8} style={{ padding: 6, opacity: i === 0 ? 0.25 : 1 }}>
                  <Icon name="chevron.up" fallback="chevron-up" size={16} color={t.colors.accent} />
                </Pressable>
                <Pressable
                  onPress={() => move(i, 1)}
                  disabled={i === members.length - 1}
                  hitSlop={8}
                  style={{ padding: 6, opacity: i === members.length - 1 ? 0.25 : 1 }}
                >
                  <Icon name="chevron.down" fallback="chevron-down" size={16} color={t.colors.accent} />
                </Pressable>
                <Pressable onPress={() => toggleMember(email)} hitSlop={8} style={{ padding: 6 }}>
                  <Icon name="minus.circle.fill" fallback="remove-circle" size={18} color={t.colors.accent} />
                </Pressable>
              </View>
            ))
          )}
        </Group>

        {notInRotation.length > 0 ? (
          <Group title="Add to the rotation">
            {notInRotation.map((email, i) => (
              <Pressable
                key={email}
                onPress={() => toggleMember(email)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderBottomWidth: i === notInRotation.length - 1 ? 0 : 0.5,
                  borderBottomColor: t.colors.separator,
                }}
              >
                <Icon name="plus.circle.fill" fallback="add-circle" size={18} color={t.colors.accent} />
                <Text style={{ color: t.colors.label, marginLeft: 10, ...type.body }}>{email}</Text>
              </Pressable>
            ))}
          </Group>
        ) : null}

        {state.unknownMembers.length > 0 ? (
          <Group title="Not staff any more">
            <View style={{ padding: 14 }}>
              <Text style={{ color: t.colors.accent, ...type.body }}>
                {state.unknownMembers.join(", ")} — their weeks ring nobody. Remove them from the rotation.
              </Text>
            </View>
          </Group>
        ) : null}

        {dirty ? (
          <View style={{ paddingHorizontal: 16, marginTop: 4 }}>
            <PrimaryButton label="Save rotation" onPress={save} disabled={saving} busy={saving} />
          </View>
        ) : null}

        <Group title="Next eight weeks" footer="Tap a week to change who covers it. A swap applies to that week only — it never shifts the rotation.">
          {state.weeks.map((w, i) => (
            <Pressable
              key={w.weekStart}
              onPress={() => cycleWeek(w.weekStart, w.email)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderBottomWidth: i === state.weeks.length - 1 ? 0 : 0.5,
                borderBottomColor: t.colors.separator,
              }}
            >
              <Text style={{ color: t.colors.label, flex: 1, ...type.body }}>
                {weekLabel(w.weekStart)}
                {i === 0 ? "  (now)" : ""}
              </Text>
              <Text style={{ color: w.email ? t.colors.labelSecondary : t.colors.accent, ...type.body }}>
                {w.email ? shortName(w.email) : "Nobody"}
              </Text>
              {w.source === "override" ? (
                <Text style={{ color: t.colors.labelSecondary, marginLeft: 6, ...type.footnote }}>swapped</Text>
              ) : w.source === "rotation" ? (
                <Text style={{ color: t.colors.labelSecondary, marginLeft: 6, ...type.footnote }}>rotation</Text>
              ) : null}
            </Pressable>
          ))}
        </Group>
      </ScrollView>
    </Screen>
  );
}
