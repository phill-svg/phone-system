import { chooseAudioDevice, type AudioDeviceLike } from "../src/lib/audioRouting";

const ear: AudioDeviceLike = { uuid: "e", type: "earpiece" };
const spk: AudioDeviceLike = { uuid: "s", type: "speaker" };
const bt: AudioDeviceLike = { uuid: "b", type: "bluetooth" };

describe("chooseAudioDevice", () => {
  it("selects the device matching a concrete pref", () => {
    expect(chooseAudioDevice([ear, spk], "speaker", true)).toEqual(spk);
    expect(chooseAudioDevice([ear, spk], "earpiece", true)).toEqual(ear);
  });
  it("selects bluetooth for a bluetooth pref only when allowed", () => {
    expect(chooseAudioDevice([ear, bt], "bluetooth", true)).toEqual(bt);
    expect(chooseAudioDevice([ear, bt], "bluetooth", false)).toBeNull();
  });
  it("automatic prefers bluetooth when allowed, else null", () => {
    expect(chooseAudioDevice([ear, spk, bt], "automatic", true)).toEqual(bt);
    expect(chooseAudioDevice([ear, spk, bt], "automatic", false)).toBeNull();
    expect(chooseAudioDevice([ear, spk], "automatic", true)).toBeNull();
  });
  it("returns null when the preferred type is absent", () => {
    expect(chooseAudioDevice([ear], "bluetooth", true)).toBeNull();
    expect(chooseAudioDevice([ear], "speaker", true)).toBeNull();
  });
  it("never returns bluetooth when disallowed, even under automatic", () => {
    expect(chooseAudioDevice([bt], "automatic", false)).toBeNull();
  });
});
