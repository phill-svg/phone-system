import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAudioAsset, getAudioAsset, listAudioAssets } from "../../src/db/audioAssets";

describe("audioAssets db", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ivr_audio_assets").run();
  });

  it("createAudioAsset inserts a row that getAudioAsset can retrieve", async () => {
    await createAudioAsset(env.DB, {
      id: "asset-1",
      label: "Welcome greeting",
      r2Key: "ivr-audio/asset-1",
      contentType: "audio/mpeg",
    });

    const asset = await getAudioAsset(env.DB, "asset-1");
    expect(asset).toEqual({
      id: "asset-1",
      label: "Welcome greeting",
      r2Key: "ivr-audio/asset-1",
      contentType: "audio/mpeg",
      uploadedAt: expect.any(Number),
    });
  });

  it("getAudioAsset returns null for an unknown id", async () => {
    const asset = await getAudioAsset(env.DB, "does-not-exist");
    expect(asset).toBeNull();
  });

  it("listAudioAssets returns all assets newest-first", async () => {
    // Insert directly with explicit, well-separated timestamps so ordering is
    // deterministic regardless of how fast Date.now() ticks between inserts.
    await env.DB.prepare(
      "INSERT INTO ivr_audio_assets (id, label, r2_key, content_type, uploaded_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("asset-old", "Old", "ivr-audio/asset-old", "audio/mpeg", 1000)
      .run();
    await env.DB.prepare(
      "INSERT INTO ivr_audio_assets (id, label, r2_key, content_type, uploaded_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("asset-new", "New", "ivr-audio/asset-new", "audio/mpeg", 2000)
      .run();

    const assets = await listAudioAssets(env.DB);
    expect(assets.map((a) => a.id)).toEqual(["asset-new", "asset-old"]);
  });
});
