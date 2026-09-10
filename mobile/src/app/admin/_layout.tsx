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
      <Stack.Screen name="index" options={{ title: "Admin", headerLeft: () => <BackToSettings /> }} />
      <Stack.Screen name="business-hours" options={{ title: "Business Hours" }} />
      <Stack.Screen name="blocklist" options={{ title: "Call Blocklist" }} />
      <Stack.Screen name="numbers" options={{ title: "Phone Numbers" }} />
      <Stack.Screen name="on-call" options={{ title: "After-hours On Call" }} />
      <Stack.Screen name="ivr/index" options={{ title: "Phone Menu" }} />
      <Stack.Screen name="ivr/[nodeId]" options={{ title: "Step" }} />
      <Stack.Screen name="diagnostics" options={{ title: "Health Checks" }} />
      <Stack.Screen name="staff/index" options={{ title: "Staff" }} />
      <Stack.Screen name="staff/[email]" options={{ title: "Staff Member" }} />
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
