import { Alert } from "react-native";

// Delete-with-undo, shared by the call log and the conversation list.
//
// Both hide business-wide records that everyone sees, so both confirm first and then offer the way
// back immediately -- an undo buried in a settings screen is one nobody finds at the moment they
// need it. `undo` is only wired up when the delete actually succeeded.
export function confirmDelete(opts: {
  title: string;
  message: string;
  onDelete: () => Promise<() => Promise<void>>;
  onDone: () => void;
}): void {
  Alert.alert(opts.title, opts.message, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        let undo: () => Promise<void>;
        try {
          undo = await opts.onDelete();
        } catch (e) {
          Alert.alert("Couldn't delete", e instanceof Error ? e.message : "Try again in a moment.");
          return;
        }
        opts.onDone();
        Alert.alert("Deleted", "It's hidden from everyone. The recording and the record are kept.", [
          { text: "OK", style: "cancel" },
          {
            text: "Undo",
            onPress: async () => {
              try {
                await undo();
              } catch (e) {
                Alert.alert("Couldn't undo", e instanceof Error ? e.message : "Try again in a moment.");
                return;
              }
              opts.onDone();
            },
          },
        ]);
      },
    },
  ]);
}
