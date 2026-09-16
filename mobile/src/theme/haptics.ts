import * as Haptics from "expo-haptics";

// `.catch(() => {})` only swallows an ASYNC rejection -- it does nothing for a SYNCHRONOUS throw
// during the call that creates the promise (e.g. the native module isn't linked/ready). A call
// site that fires haptics before its real work -- exactly the shape of call-incoming.tsx's
// `answer()`/`decline()`, where the haptic sits before the try/catch -- would have that throw abort
// the whole handler: no accept(), no reject(), no dismiss(), and the screen looks frozen with no
// feedback at all. Wrapping the CALL itself, not just its promise, is what the comment below always
// claimed this file already did.
function safe(fire: () => Promise<void>): void {
  try {
    fire().catch(() => {});
  } catch {
    // A failure to buzz must never break an interaction.
  }
}

// Thin wrapper so call sites read intently ("tap", "press") and so haptics can be
// globally muted later (e.g. a Settings toggle) from one place. All calls are
// fire-and-forget; a failure to buzz must never break an interaction.
export const haptics = {
  tap: () => safe(() => Haptics.selectionAsync()),
  press: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
