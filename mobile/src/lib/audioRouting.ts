// Pure audio-route selection logic — deliberately NO native SDK import so jest can test it.
// voice.ts maps the SDK's AudioDevice[] into AudioDeviceLike[] and calls this to decide what to select.

export type AudioRoutePref = "automatic" | "earpiece" | "speaker" | "bluetooth";
export type AudioDeviceLike = { uuid: string; type: "earpiece" | "speaker" | "bluetooth"; name?: string };

export function chooseAudioDevice(
  devices: AudioDeviceLike[],
  pref: AudioRoutePref,
  bluetoothAllowed: boolean,
): AudioDeviceLike | null {
  const find = (t: AudioDeviceLike["type"]) => devices.find((d) => d.type === t) ?? null;

  if (pref === "bluetooth") return bluetoothAllowed ? find("bluetooth") : null;
  if (pref === "speaker") return find("speaker");
  if (pref === "earpiece") return find("earpiece");

  // automatic: prefer a connected bluetooth device when allowed; otherwise let the SDK decide.
  if (bluetoothAllowed) {
    const bt = find("bluetooth");
    if (bt) return bt;
  }
  return null;
}
