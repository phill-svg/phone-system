import { AppState } from "react-native";
import { focusManager } from "@tanstack/react-query";

type AppStateLike = {
  addEventListener: (type: "change", fn: (status: string) => void) => { remove: () => void };
};

// React Query's refetch-on-focus is wired to the browser's `visibilitychange`, which React Native
// does not have, so out of the box it never fires and nothing refreshes when the app comes back to
// the foreground. This makes "the app became active" the focus signal -- which also pauses every
// refetchInterval while the app is in the background.
export function wireQueryFocusToAppState(appState: AppStateLike = AppState): void {
  focusManager.setEventListener((setFocused) => {
    const sub = appState.addEventListener("change", (status) => setFocused(status === "active"));
    return () => sub.remove();
  });
}
