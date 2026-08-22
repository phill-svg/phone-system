import React from "react";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../lib/auth";
import { RegistrationProvider } from "../lib/registration";
import { useTheme, ThemeProvider } from "../theme/theme";

const queryClient = new QueryClient();

function RootNavigator() {
  const t = useTheme();
  const { status } = useAuth();

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
          <Stack.Screen name="call/[id]" options={{ ...headerScreen, title: "Call Details" }} />
          <Stack.Screen name="contact/[id]" options={{ ...headerScreen, title: "" }} />
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
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RootNavigator />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
});
