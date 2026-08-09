import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("IVR flow seeding", () => {
  it("creates ivr_audio_assets and ivr_nodes tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["ivr_audio_assets", "ivr_nodes"])
    );
  });

  describe("main flow", () => {
    it("has exactly one is_entry node", async () => {
      const result = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM ivr_nodes WHERE flow = 'main' AND is_entry = 1"
      ).first<{ count: number }>();
      expect(result?.count).toBe(1);
    });

    it("entry node is a gather with 4 digit options", async () => {
      const node = await env.DB.prepare(
        "SELECT id, type, config FROM ivr_nodes WHERE flow = 'main' AND is_entry = 1"
      ).first<{ id: string; type: string; config: string }>();

      expect(node?.type).toBe("gather");
      expect(node?.id).toBe("main_entry_gather");

      const config = JSON.parse(node?.config || "{}");
      expect(config.options).toHaveLength(4);
      expect(config.options.map((o: any) => o.digit)).toEqual(
        expect.arrayContaining(["0", "1", "2", "3"])
      );
    });

    it("has 4 ring nodes for each main menu route", async () => {
      const result = await env.DB.prepare(
        "SELECT id, config FROM ivr_nodes WHERE flow = 'main' AND type = 'ring' ORDER BY id"
      ).all<Array<{ id: string; config: string }>>();

      const ringNodeIds = result.results.map((r) => r.id);
      expect(ringNodeIds).toEqual(
        expect.arrayContaining([
          "main_ring_new_booking",
          "main_ring_existing_job",
          "main_ring_emergency",
          "main_ring_operator",
        ])
      );
      expect(ringNodeIds).toHaveLength(4);
    });

    it("all ring nodes target all", async () => {
      const result = await env.DB.prepare(
        "SELECT id, config FROM ivr_nodes WHERE flow = 'main' AND type = 'ring' ORDER BY id"
      ).all<Array<{ id: string; config: string }>>();

      expect(result.results).toHaveLength(4);
      result.results.forEach((row) => {
        const config = JSON.parse(row.config);
        expect(config.target).toBe("all");
      });
    });

    it("all ring nodes point to voicemail on no-answer", async () => {
      const result = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE flow = 'main' AND type = 'ring'"
      ).all<Array<{ config: string }>>();

      result.results.forEach((row) => {
        const config = JSON.parse(row.config);
        expect(config.noAnswerNextNodeId).toBe("shared_voicemail");
      });
    });

    it("has a shared voicemail node", async () => {
      const node = await env.DB.prepare(
        "SELECT id, type FROM ivr_nodes WHERE id = 'shared_voicemail'"
      ).first<{ id: string; type: string }>();

      expect(node?.id).toBe("shared_voicemail");
      expect(node?.type).toBe("voicemail");
    });

    it("voicemail node has the correct prompt", async () => {
      const node = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE id = 'shared_voicemail'"
      ).first<{ config: string }>();

      const config = JSON.parse(node?.config || "{}");
      expect(config.ttsText).toContain(
        "Sorry we're unable to take your call right now"
      );
      expect(config.ttsText).toContain("Please leave a message after the tone");
    });

    it("main entry gather has retryLimit of 3", async () => {
      const node = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE id = 'main_entry_gather'"
      ).first<{ config: string }>();

      const config = JSON.parse(node?.config || "{}");
      expect(config.retryLimit).toBe(3);
    });
  });

  describe("after-hours flow", () => {
    it("has exactly one is_entry node", async () => {
      const result = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM ivr_nodes WHERE flow = 'after_hours' AND is_entry = 1"
      ).first<{ count: number }>();
      expect(result?.count).toBe(1);
    });

    it("entry node is a gather with 1 digit option", async () => {
      const node = await env.DB.prepare(
        "SELECT id, type, config FROM ivr_nodes WHERE flow = 'after_hours' AND is_entry = 1"
      ).first<{ id: string; type: string; config: string }>();

      expect(node?.type).toBe("gather");
      expect(node?.id).toBe("after_hours_entry_gather");

      const config = JSON.parse(node?.config || "{}");
      expect(config.options).toHaveLength(1);
      expect(config.options[0].digit).toBe("1");
    });

    it("has an emergency ring node", async () => {
      const node = await env.DB.prepare(
        "SELECT id, type FROM ivr_nodes WHERE id = 'after_hours_ring_emergency'"
      ).first<{ id: string; type: string }>();

      expect(node?.id).toBe("after_hours_ring_emergency");
      expect(node?.type).toBe("ring");
    });

    it("emergency ring node targets on_call_only", async () => {
      const node = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE id = 'after_hours_ring_emergency'"
      ).first<{ config: string }>();

      const config = JSON.parse(node?.config || "{}");
      expect(config.target).toBe("on_call_only");
    });

    it("emergency ring node points to voicemail on no-answer", async () => {
      const node = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE id = 'after_hours_ring_emergency'"
      ).first<{ config: string }>();

      const config = JSON.parse(node?.config || "{}");
      expect(config.noAnswerNextNodeId).toBe("shared_voicemail");
    });

    it("after-hours entry gather has retryLimit of 1", async () => {
      const node = await env.DB.prepare(
        "SELECT config FROM ivr_nodes WHERE id = 'after_hours_entry_gather'"
      ).first<{ config: string }>();

      const config = JSON.parse(node?.config || "{}");
      expect(config.retryLimit).toBe(1);
    });
  });

  it("both flows use the same shared voicemail node", async () => {
    const mainVoicemail = await env.DB.prepare(
      "SELECT config FROM ivr_nodes WHERE flow = 'main' AND type = 'gather' AND is_entry = 1"
    ).first<{ config: string }>();

    const afterHoursVoicemail = await env.DB.prepare(
      "SELECT config FROM ivr_nodes WHERE flow = 'after_hours' AND type = 'gather' AND is_entry = 1"
    ).first<{ config: string }>();

    const mainConfig = JSON.parse(mainVoicemail?.config || "{}");
    const afterHoursConfig = JSON.parse(afterHoursVoicemail?.config || "{}");

    expect(mainConfig.defaultNextNodeId).toBe("shared_voicemail");
    expect(afterHoursConfig.defaultNextNodeId).toBe("shared_voicemail");

    // Verify there is exactly one shared_voicemail node in the entire table
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM ivr_nodes WHERE id = 'shared_voicemail'"
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
