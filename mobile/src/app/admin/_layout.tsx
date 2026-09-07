import React from "react";
import { Stack, Redirect } from "expo-router";
import { useAuth } from "../../lib/auth";
import { useTheme } from "../../theme/theme";

// Everything under /admin is admin-only. The server enforces this too (every endpoint these
// screens call 403s a non-admin), but a staff member who somehow lands here -- a deep link, a
// stale nav stack after a role change -- gets bounced to Settings rather than a wall of failures.
// `user` is null only while the session is being restored offline, and Settings hides the entry
// point in that state, so treating "not known to be admin" as "not admin" is the safe reading.
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
      <Stack.Screen name="index" options={{ title: "Admin" }} />
      <Stack.Screen name="business-hours" options={{ title: "Business Hours" }} />
      <Stack.Screen name="blocklist" options={{ title: "Call Blocklist" }} />
      <Stack.Screen name="numbers" options={{ title: "Phone Numbers" }} />
      <Stack.Screen name="diagnostics" options={{ title: "Health Checks" }} />
      <Stack.Screen name="staff/index" options={{ title: "Staff" }} />
      <Stack.Screen name="staff/[email]" options={{ title: "Staff Member" }} />
    </Stack>
  );
}
