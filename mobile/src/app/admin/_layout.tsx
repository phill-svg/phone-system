import React from "react";
import { Pressable, Text } from "react-native";
import { Stack, Redirect, router } from "expo-router";
import { Icon } from "../../components/ui/Icon";
import { leaveAdmin } from "../../lib/nav";
import { useAuth } from "../../lib/auth";
import { useTheme } from "../../theme/theme";

// Everything under /admin is admin-only. The server enforces this too (every endpoint these
// screens call 403s a non-admin), but a staff member who somehow lands here -- a deep link, a
// stale nav stack after a role change -- gets bounced to Settings rather than a wall of failures.
// `user` is null only while the session is being restored offline, and Settings hides the entry
// point in that state, so treating "not known to be admin" as "not admin" is the safe reading.
//
// The hub screen needs its own back button, and the reason is structural rather than cosmetic.
// `admin` is a SIBLING of `(tabs)` in the root stack, so the tab bar is not rendered here; and
// `index` is the ROOT of this nested stack, so React Navigation draws no automatic back button --
// there is nothing behind it within this navigator. Between the two, the hub had no way out at all
// except an edge swipe, which is not discoverable and does not exist on Android. Sub-screens are
// fine: they are pushed inside this stack and get the usual chevron.
// The screen list is DATA so a test can assert the hub still carries its own back button.
// `leaveAdmin`'s rule was already tested, but deleting this one `headerLeft` left every test green
// while stranding the hub exactly as before -- and this file is rewritten often enough for that to
// be a real risk (#91 added two rows to it). A test that green-lights the reverted fix is not a
// test, which is the lesson this repo keeps relearning.
export const ADMIN_SCREENS: { name: string; options: { title: string; headerLeft?: () => React.ReactElement } }[] = [
  { name: "index", options: { title: "Admin", headerLeft: () => <BackToSettings /> } },
  { name: "business-hours", options: { title: "Business Hours" } },
  { name: "blocklist", options: { title: "Call Blocklist" } },
  { name: "numbers", options: { title: "Phone Numbers" } },
  { name: "on-call", options: { title: "After-hours On Call" } },
  { name: "ivr/index", options: { title: "Phone Menu" } },
  { name: "ivr/[nodeId]", options: { title: "Step" } },
  { name: "diagnostics", options: { title: "Health Checks" } },
  { name: "staff/index", options: { title: "Staff" } },
  { name: "staff/[email]", options: { title: "Staff Member" } },
];

export default function AdminLayout() {
  const t = useTheme();
  const { user } = useAuth();

  if (user?.role !== "admin") return <Redirect href="/(tabs)/settings" />;

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: t.colors.bgElevated },
        headerTitleStyle: { color: t.colors.label },
        headerTintColor: t.colors.accent,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: t.colors.bg },
      }}
    >
      {ADMIN_SCREENS.map((screen) => (
        <Stack.Screen key={screen.name} name={screen.name} options={screen.options} />
      ))}
    </Stack>
  );
}

// The pop-or-replace rule is in `lib/nav` so it can be tested: its failure mode is a button that
// does nothing, which is the exact bug this component exists to fix.
function BackToSettings() {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => leaveAdmin(router)}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel="Back to Settings"
      style={{ flexDirection: "row", alignItems: "center", paddingRight: 8 }}
    >
      <Icon name="chevron.left" fallback="chevron-back" size={20} color={t.colors.accent} />
      <Text style={{ color: t.colors.accent, fontSize: 17, marginLeft: 2 }}>Settings</Text>
    </Pressable>
  );
}
