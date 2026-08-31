import { describe, expect, it, vi } from "vitest";
import { handleDesktopUpdateAsset } from "../../src/api/desktopUpdates";

// A stub bucket rather than the real R2 binding: miniflare's isolated R2 storage hits EBUSY file
// locks on Windows, and the behaviour worth pinning here is our own — which keys we are willing to
// ask for. The stub records every key requested, so a filename that escapes the desktop/ prefix is
// caught by assertion rather than by hoping R2 has nothing there.
function stubBucket(contents: Record<string, string>) {
  const requestedKeys: string[] = [];
  const bucket = {
    get: vi.fn(async (key: string) => {
      requestedKeys.push(key);
      const body = contents[key];
      if (body === undefined) return null;
      return { body, size: body.length, httpEtag: '"etag"' };
    }),
  } as unknown as R2Bucket;
  return { bucket, requestedKeys };
}

const CONTENTS = {
  "desktop/latest.yml": "version: 1.2.0\n",
  "desktop/TCB-Phone-Setup-1.2.0.exe": "MZ-fake-installer",
  // A private asset in the same bucket. This route is public; nothing may ever reach it.
  "greeting-secret.mp3": "customer voicemail greeting",
};

describe("desktop update feed", () => {
  it("serves the update manifest", async () => {
    const { bucket } = stubBucket(CONTENTS);
    const res = await handleDesktopUpdateAsset(bucket, "latest.yml");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("1.2.0");
  });

  it("serves the installer as a binary download", async () => {
    const { bucket } = stubBucket(CONTENTS);
    const res = await handleDesktopUpdateAsset(bucket, "TCB-Phone-Setup-1.2.0.exe");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  // latest.yml is polled for new versions; a cached copy would pin everyone to an old release.
  it("keeps the manifest uncached and the installer cached", async () => {
    const { bucket } = stubBucket(CONTENTS);
    expect((await handleDesktopUpdateAsset(bucket, "latest.yml")).headers.get("Cache-Control")).toBe("no-cache");
    expect(
      (await handleDesktopUpdateAsset(bucket, "TCB-Phone-Setup-1.2.0.exe")).headers.get("Cache-Control")
    ).toContain("immutable");
  });

  it("404s for a file that isn't there", async () => {
    const { bucket } = stubBucket(CONTENTS);
    expect((await handleDesktopUpdateAsset(bucket, "nope.yml")).status).toBe(404);
  });

  // The bucket also holds IVR audio and voicemail greetings. This route is public, so a filename
  // that escapes the desktop/ prefix would hand those to anyone who asks.
  it("refuses any filename that could escape the desktop prefix", async () => {
    const { bucket, requestedKeys } = stubBucket(CONTENTS);
    for (const attempt of [
      "../greeting-secret.mp3",
      "..%2Fgreeting-secret.mp3",
      "../../greeting-secret.mp3",
      "desktop/../greeting-secret.mp3",
      "a/b.yml",
      "..",
      "",
      "/greeting-secret.mp3",
      ".hidden",
    ]) {
      const res = await handleDesktopUpdateAsset(bucket, attempt);
      expect(res.status, `expected 404 for ${JSON.stringify(attempt)}`).toBe(404);
    }
    // The guard must reject before touching R2 at all — no key was ever looked up.
    expect(requestedKeys).toEqual([]);
  });

  it("only ever reads keys under the desktop prefix", async () => {
    const { bucket, requestedKeys } = stubBucket(CONTENTS);
    await handleDesktopUpdateAsset(bucket, "latest.yml");
    await handleDesktopUpdateAsset(bucket, "TCB-Phone-Setup-1.2.0.exe");
    expect(requestedKeys.every((k) => k.startsWith("desktop/"))).toBe(true);
  });
});
