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
import { primePushRegistry } from "../lib/voice";

const queryClient = new QueryClient();

// Installed at module scope, before any component renders, so an error thrown while the tree is
// first mounting is still caught -- that is precisely when the worst ones happen.
installCrashReporter();

// Before ANY of the tree renders, and deliberately not inside a component: a VoIP push wakes the
// app in the background with about five seconds to report the call to CallKit before iOS kills it
// (0xBAADCA11). Waiting for auth and navigation to settle first is what was losing that race.
//
// This import pulls @twilio/voice-react-native-sdk into the ROOT layout's module graph, and the SDK
// does native lookups at import time -- outside anything the Platform guard or the catch inside
// primePushRegistry can cover. Accepted knowingly: the framework is compiled into every build of
// this app (TwilioVoice.framework is right there in the 2026-09-10 crash log's loaded images), so
// there is no build on which this import can fail. If the SDK is ever made optional, this must
// become a lazy require -- otherwise it moves an SDK-missing failure from the login screen to a
// launch crash with no UI at all.
void primePushRegistry();

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
