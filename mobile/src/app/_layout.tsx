import React, { useEffect } from "react";
import { Stack, usePathname } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AuthProvider, useAuth } from "../lib/auth";
import { UserSettingsProvider } from "../lib/userSettings";
import { RegistrationProvider } from "../lib/registration";
import { useTheme, ThemeProvider } from "../theme/theme";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { installCrashReporter, flushCrashQueue, setCurrentScreen } from "../lib/crashReport";

const queryClient = new QueryClient();

// Installed at module scope, before any component renders, so an error thrown while the tree is
// first mounting is still caught -- that is precisely when the worst ones happen.
installCrashReporter();

function RootNavigator() {
  const t = useTheme();
  const { status } = useAuth();
  const pathname = usePathname();

  // The route is recorded for crash reports, which are gathered outside React and cannot read it.
  useEffect(() => setCurrentScreen(pathname), [pathname]);

  // Anything last launch could not send goes out once signed in -- the endpoint is authenticated,
  // and a crash on the login screen is exactly the case where the queue has to survive until then.
  useEffect(() => {
    if (status === "authed") void flushCrashQueue();
  }, [status]);

  if (status === "loading") {
    return (
      <View style={[styles.loading, { backgroundColor: t.colors.bg }]}>
        <ActivityIndicator color={t.colors.accent} />
      </View>
    );
  }

  const headerScreen = {
    headerShown: true,
    headerStyle: { backgroundColor: t.colors.bgElevated },
    headerTitleStyle: { color: t.colors.label },
    headerTintColor: t.colors.accent,
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal" as const,
    contentStyle: { backgroundColor: t.colors.bg },
  };

  return (
    <RegistrationProvider enabled={status === "authed"}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.colors.bg } }}>
        <Stack.Protected guard={status === "authed"}>
          <Stack.Screen name="(tabs)" />
          {/* The admin group brings its own Stack (and its own admin-only guard). */}
          <Stack.Screen name="admin" />
          <Stack.Screen name="call/[id]" options={{ ...headerScreen, title: "Call Details" }} />
          <Stack.Screen name="contact/[id]" options={{ ...headerScreen, title: "" }} />
          <Stack.Screen name="call-forwarding" options={{ ...headerScreen, title: "Ring My Mobile" }} />
          <Stack.Screen name="thread/[number]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen name="call-active" options={{ presentation: "fullScreenModal", animation: "fade", gestureEnabled: false }} />
          <Stack.Screen name="call-incoming" options={{ presentation: "fullScreenModal", animation: "fade", gestureEnabled: false }} />
          <Stack.Screen name="transfer" options={{ presentation: "modal" }} />
          <Stack.Screen name="contact-edit" options={{ presentation: "modal" }} />
        </Stack.Protected>
        <Stack.Protected guard={status === "anon"}>
          <Stack.Screen name="login" />
        </Stack.Protected>
      </Stack>
    </RegistrationProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <UserSettingsProvider>
                <ErrorBoundary>
                  <RootNavigator />
                </ErrorBoundary>
              </UserSettingsProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
});
