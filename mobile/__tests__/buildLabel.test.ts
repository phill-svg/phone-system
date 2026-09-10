import { OTA_BUILD, buildLabel } from "../src/lib/build";

// "Is the native fix on this handset?" cannot be answered by the OTA number alone: an OTA reaches
// every binary sharing the runtimeVersion (policy appVersion, 1.0.0 for all of them), so a phone
// on an older build reports the newest OTA while missing everything that shipped natively.
describe("buildLabel", () => {
  it("names the native binary alongside the OTA, because only the binary carries native fixes", () => {
    expect(buildLabel("4")).toBe(`#${OTA_BUILD} · b4`);
    expect(buildLabel("3")).not.toBe(buildLabel("4"));
  });

  it("falls back to the OTA number where there is no native build to name", () => {
    // Expo Go reports null. Showing "· bnull" would be worse than showing nothing.
    expect(buildLabel(null)).toBe(`#${OTA_BUILD}`);
  });
});
