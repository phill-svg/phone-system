import {
  IVR_NODE_PUT_FIELDS,
  configsEqual,
  incompleteReason,
  orderNodes,
  outgoingIds,
  removeNode,
  nodeSummary,
  blankConfigFor,
  toPutPayload,
  addStepTo,
  IVR_NODE_TYPES,
  NEXT_FIELDS,
  normalizeFlowName,
  type IvrFlow,
  type IvrNode,
  type IvrNodeType,
} from "../src/lib/ivr";

function node(id: string, type: IvrNodeType, config: Record<string, unknown>, isEntry = false): IvrNode {
  return { id, flow: "main", isEntry, type, config, positionX: 10, positionY: 20 };
}

// The shape of the real production flow on 2026-09-10, which is what this screen has to render.
const FLOW: IvrFlow = {
  entryNodeId: "hours",
  nodes: [
    node("vm_after", "voicemail", { mailboxLabel: "after hours" }),
    node("ring1", "ring", { target: "all", strategy: "simultaneous", timeoutSeconds: 20, noAnswerNextNodeId: "menu" }),
    node("hours", "business_hours", { openNextNodeId: "greeting", closedNextNodeId: "vm_after" }, true),
    node("greeting", "play", { ttsText: "Welcome", nextNodeId: "ring1" }),
    node("menu", "gather", { options: [{ digit: "1", nextNodeId: "cb" }], defaultNextNodeId: "ring1", retryLimit: 1 }),
    node("cb", "callback", { ttsText: "Logged" }),
  ],
};

describe("orderNodes", () => {
  // The raw order is whatever SELECT * returns. In FLOW above, the after-hours voicemail is row
  // ONE and the entry step is row three -- a list in that order shows you the end of the call
  // before the start of it, which is unreadable.
  it("walks the flow from the entry step, not the row order", () => {
    const { ordered } = orderNodes(FLOW);
    expect(ordered[0].id).toBe("hours");
    expect(ordered.map((n) => n.id)).toEqual(["hours", "greeting", "vm_after", "ring1", "menu", "cb"]);
  });

  it("follows menu keys as well as the plain next fields", () => {
    const { ordered } = orderNodes(FLOW);
    expect(ordered.map((n) => n.id)).toContain("cb");
  });

  // An orphan is usually a half-finished edit, and it is exactly what somebody opening this screen
  // needs to see -- so it is listed apart, never hidden.
  it("reports an unreachable step instead of dropping it", () => {
    const orphan = node("orphan", "voicemail", { mailboxLabel: "Lost" });
    const { ordered, unreachable } = orderNodes({ ...FLOW, nodes: [...FLOW.nodes, orphan] });
    expect(ordered.map((n) => n.id)).not.toContain("orphan");
    expect(unreachable.map((n) => n.id)).toEqual(["orphan"]);
  });

  // A menu whose default loops back to an earlier step is an ordinary IVR shape, and a naive walk
  // would never return.
  it("terminates on a cycle", () => {
    const cyclic: IvrFlow = {
      entryNodeId: "a",
      nodes: [
        node("a", "play", { ttsText: "", nextNodeId: "b" }, true),
        node("b", "play", { ttsText: "", nextNodeId: "a" }),
      ],
    };
    expect(orderNodes(cyclic).ordered.map((n) => n.id)).toEqual(["a", "b"]);
  });

  // The callback step a Hold step names supplies the words callers hear, so it is in use -- but
  // only while callbacks are on, and only a callback step (the line runs nothing else).
  describe("a Hold step's callback line", () => {
    const flow = (allowCallbackStar: boolean, targetType: IvrNodeType): IvrFlow => ({
      entryNodeId: "w",
      nodes: [
        node("w", "wait", { audioAssetId: null, ttsText: "", nextNodeId: "", allowCallbackStar, callbackNextNodeId: "t" }, true),
        node("t", targetType, targetType === "callback" ? { ttsText: "Logged" } : { mailboxLabel: "VM" }),
      ],
    });

    it("lists the callback step it names while callbacks are on", () => {
      expect(orderNodes(flow(true, "callback")).ordered.map((n) => n.id)).toEqual(["w", "t"]);
    });

    it("leaves that step unreachable while callbacks are off", () => {
      expect(orderNodes(flow(false, "callback")).unreachable.map((n) => n.id)).toEqual(["t"]);
    });

    it("does not reach a step that is not a callback step", () => {
      expect(orderNodes(flow(true, "voicemail")).unreachable.map((n) => n.id)).toEqual(["t"]);
    });
  });

  it("treats every step as unreachable when no entry is set", () => {
    const { ordered, unreachable } = orderNodes({ ...FLOW, entryNodeId: null });
    expect(ordered).toEqual([]);
    expect(unreachable).toHaveLength(FLOW.nodes.length);
  });
});

describe("outgoingIds", () => {
  // A blank "next" is legal and normal -- the API allows it so a flow can be built up piece by
  // piece -- so it must not read as a link to a step called "".
  it("ignores blank references", () => {
    expect(outgoingIds(node("x", "play", { nextNodeId: "" }))).toEqual([]);
  });

  // Nothing is run through a Hold step's callback line -- calls only read the callback step's words.
  it("never treats a Hold step's callback line as a route", () => {
    const base = { audioAssetId: null, ttsText: "", nextNodeId: "ring1", callbackNextNodeId: "cb1" };
    expect(outgoingIds(node("w", "wait", { ...base, allowCallbackStar: true }))).toEqual(["ring1"]);
    expect(outgoingIds(node("w", "wait", { ...base, allowCallbackStar: false }))).toEqual(["ring1"]);
  });
});

describe("removeNode", () => {
  // Leaving a dangling id behind is the worst outcome: it only fails when a real call reaches it,
  // mid-call, and nothing anywhere reports it beforehand.
  it("clears every reference to the deleted step", () => {
    const after = removeNode(FLOW, "vm_after");
    const hours = after.nodes.find((n) => n.id === "hours")!;
    expect(hours.config.closedNextNodeId).toBe("");
    expect(hours.config.openNextNodeId).toBe("greeting");
    expect(after.nodes.map((n) => n.id)).not.toContain("vm_after");
  });

  it("clears a menu key that pointed at the deleted step", () => {
    const after = removeNode(FLOW, "cb");
    const menu = after.nodes.find((n) => n.id === "menu")!;
    expect((menu.config.options as { nextNodeId: string }[])[0].nextNodeId).toBe("");
  });

  it("drops the entry marker when the entry step itself goes", () => {
    expect(removeNode(FLOW, "hours").entryNodeId).toBeNull();
  });

});

// PUT /api/ivr/flows/:flow is a full delete-and-reinsert, so anything this app does not carry back
// is destroyed. The previous version of this test asserted through removeNode's `{ ...n }` spread
// with a `node()` helper that set the positions regardless of the type -- so deleting
// positionX/positionY from IvrNode, the mutation that would actually flatten the web canvas, left
// it green. Types are erased at runtime; only a runtime field list can pin this.
describe("toPutPayload", () => {
  it("sends every field the server persists, and nothing else", () => {
    // Mirrors the INSERT in src/db/ivrNodes.ts (id, flow, is_entry, type, config, position_x,
    // position_y) minus created_at/updated_at, which the server regenerates.
    expect([...IVR_NODE_PUT_FIELDS].sort()).toEqual(
      ["config", "flow", "id", "isEntry", "positionX", "positionY", "type"].sort()
    );
  });

  it("carries the web canvas positions it never reads", () => {
    const payload = toPutPayload(FLOW);
    for (const n of payload.nodes) {
      expect(n.positionX).toBe(10);
      expect(n.positionY).toBe(20);
    }
    // Every node, not just the one being edited -- the endpoint wipes the flow first.
    expect(payload.nodes).toHaveLength(FLOW.nodes.length);
  });

  it("keeps a null position null rather than coercing it", () => {
    const withNulls: IvrFlow = {
      entryNodeId: "a",
      nodes: [{ id: "a", flow: "main", isEntry: true, type: "callback", config: {}, positionX: null, positionY: null }],
    };
    expect(toPutPayload(withNulls).nodes[0].positionX).toBeNull();
  });
});

describe("incompleteReason", () => {
  it("names a redirect with no number, which the handset can now create", () => {
    // blankConfigFor("redirect") is {number: ""} and the API accepts it, so the step exists
    // half-made on purpose. Nothing else would say so.
    const n = node("r", "redirect", blankConfigFor("redirect"));
    expect(incompleteReason(n)).toBe("No phone number set");
  });

  it("names a step that would say nothing to the caller", () => {
    const n = node("p", "play", { audioAssetId: null, ttsText: "", nextNodeId: "next" });
    expect(incompleteReason(n)).toContain("Nothing to say");
  });

  it("names an unwired next field by its label, not its key", () => {
    const n = node("p", "play", { audioAssetId: null, ttsText: "Hi", nextNodeId: "" });
    expect(incompleteReason(n)).toContain("goes nowhere");
    expect(incompleteReason(n)).not.toContain("nextNodeId");
  });

  // A badge you have learned to ignore is worse than no badge, so the "nothing to say" rule covers
  // only the types where a blank prompt really does leave the caller hearing nothing. These two
  // have deliberate server-side defaults, and flagging them would invite someone to "fix" a working
  // step -- typing text into a Hold step replaces the ring cadence with a spoken line on every poll.
  it("does not flag a Hold step with no custom content, which plays the ringback tone", () => {
    const n = node("w", "wait", { audioAssetId: null, ttsText: "", allowCallbackStar: false, nextNodeId: "ring1" });
    expect(incompleteReason(n)).toBeNull();
  });

  // The summary has to show the key the caller is actually told to press, not a fixed star.
  it("names a Hold step's own callback key", () => {
    const base = { audioAssetId: null, ttsText: "", allowCallbackStar: true, nextNodeId: "ring1" };
    expect(nodeSummary(node("w", "wait", { ...base, callbackKey: "1" }))).toBe("Hold, 1 requests a callback");
    expect(nodeSummary(node("w", "wait", base))).toBe("Hold, ★ requests a callback");
    expect(nodeSummary(node("w", "wait", { ...base, callbackKey: "12" }))).toBe("Hold, ★ requests a callback");
  });

  it("does not flag a callback step with no prompt, which speaks a default line", () => {
    const n = node("cb", "callback", { audioAssetId: null, ttsText: "" });
    expect(incompleteReason(n)).toBeNull();
  });

  // A beep-only mailbox is terse but a real choice; the missing mailbox NAME is the gap that
  // actually matters there, and it is checked separately.
  it("does not flag a voicemail step for a blank prompt, only for a blank mailbox name", () => {
    const n = node("v", "voicemail", { audioAssetId: null, ttsText: "", mailboxLabel: "After hours" });
    expect(incompleteReason(n)).toBeNull();
  });

  it("says nothing about a finished step", () => {
    const n = node("p", "play", { audioAssetId: null, ttsText: "Hi", nextNodeId: "ring1" });
    expect(incompleteReason(n)).toBeNull();
  });

  it("counts a menu key that goes nowhere", () => {
    const n = node("m", "gather", {
      audioAssetId: null,
      ttsText: "Press one",
      options: [{ digit: "1", nextNodeId: "" }],
      defaultNextNodeId: "vm",
      retryLimit: 1,
    });
    expect(incompleteReason(n)).toBe("1 menu key(s) go nowhere");
  });

  it("treats whitespace as blank, so a space-only mailbox name is still unfinished", () => {
    const n = node("v", "voicemail", { audioAssetId: null, ttsText: "Leave a message", mailboxLabel: "   " });
    expect(incompleteReason(n)).toBe("No mailbox name set");
  });
});

describe("configsEqual", () => {
  it("is true for an untouched copy, so a refocus may re-seed the draft", () => {
    expect(configsEqual({ ttsText: "Hi", nextNodeId: "a" }, { ttsText: "Hi", nextNodeId: "a" })).toBe(true);
  });

  it("is false once a character is typed, which is what protects the edit", () => {
    expect(configsEqual({ ttsText: "Hi" }, { ttsText: "Hix" })).toBe(false);
  });

  it("compares a gather's options by value, not by identity", () => {
    const a = { options: [{ digit: "1", nextNodeId: "x" }] };
    const b = { options: [{ digit: "1", nextNodeId: "x" }] };
    expect(configsEqual(a, b)).toBe(true);
    expect(configsEqual(a, { options: [{ digit: "1", nextNodeId: "y" }] })).toBe(false);
  });

  it("notices a key that exists on only one side", () => {
    expect(configsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("nodeSummary", () => {
  it("names the on-call rotation rather than showing a raw target", () => {
    const ring = node("r", "ring", { target: "on_call", strategy: "cascade", timeoutSeconds: 30, noAnswerNextNodeId: "" });
    expect(nodeSummary(ring)).toBe("Rings whoever is on call for 30s");
  });

  it("describes every node type without throwing", () => {
    for (const type of IVR_NODE_TYPES) {
      expect(typeof nodeSummary(node("n", type, blankConfigFor(type)))).toBe("string");
    }
  });
});

describe("blankConfigFor", () => {
  // A new step is saved with the rest of the flow, and the server validates every node on the way
  // in -- so a blank config missing a required key would make the whole flow unsaveable, with the
  // error naming a node the person just added and cannot fix.
  it("includes every next-field the type declares", () => {
    for (const type of IVR_NODE_TYPES) {
      const config = blankConfigFor(type);
      for (const field of NEXT_FIELDS[type]) {
        expect(config).toHaveProperty(field);
      }
    }
  });
});

// "Add a step" PUT the whole flow -- the endpoint deletes and re-inserts -- from the list screen's
// focus-time copy, so a web edit made since the list opened was silently reverted. The step editor
// re-reads first for exactly this; adding a step now does too.
describe("addStepTo", () => {
  it("adds to the flow as it is NOW, not the copy the screen loaded", async () => {
    const stale: IvrFlow = { entryNodeId: "hours", nodes: [node("hours", "business_hours", {}, true)] };
    const fresh: IvrFlow = { ...stale, nodes: [...stale.nodes, node("web_edit", "play", { ttsText: "Added on the web" })] };
    const put = jest.fn().mockResolvedValue(undefined);

    await addStepTo(stale, "main", "voicemail", "new_step", { get: async () => fresh, put });

    const sent = put.mock.calls[0][0] as IvrFlow;
    expect(sent.nodes.map((n) => n.id)).toEqual(["hours", "web_edit", "new_step"]);
  });

  it("falls back to the screen's copy when the re-read fails, rather than refusing", async () => {
    const stale: IvrFlow = { entryNodeId: "hours", nodes: [node("hours", "business_hours", {}, true)] };
    const put = jest.fn().mockResolvedValue(undefined);

    await addStepTo(stale, "main", "voicemail", "new_step", { get: async () => { throw new Error("offline"); }, put });

    expect((put.mock.calls[0][0] as IvrFlow).nodes.map((n) => n.id)).toEqual(["hours", "new_step"]);
  });
});

describe("addStepTo — the first step of an empty or entry-less menu", () => {
  // A menu with no starting step cannot be SAVED at all: handlePutFlow requires an entryNodeId
  // matching exactly one node. So without this, a brand-new menu could never get its first step
  // from the handset, and one whose entry had been deleted could never be repaired — every save
  // died on the opaque "invalid request body".
  it("makes the new step the entry when the menu has none", async () => {
    const empty: IvrFlow = { entryNodeId: null, nodes: [] };
    let put: IvrFlow | null = null;
    await addStepTo(empty, "sales", "gather", "n_new", {
      get: async () => empty,
      put: async (f) => {
        put = f;
      },
    });
    expect(put!.entryNodeId).toBe("n_new");
    expect(put!.nodes.map((n) => [n.id, n.isEntry])).toEqual([["n_new", true]]);
  });

  it("repairs a menu whose entryNodeId points at a step that is gone", async () => {
    const orphaned: IvrFlow = {
      entryNodeId: "n_deleted",
      nodes: [{ id: "n_a", flow: "sales", isEntry: false, type: "play", config: {}, positionX: null, positionY: null }],
    };
    let put: IvrFlow | null = null;
    await addStepTo(orphaned, "sales", "play", "n_new", {
      get: async () => orphaned,
      put: async (f) => {
        put = f;
      },
    });
    expect(put!.entryNodeId).toBe("n_new");
  });

  // Moving an existing entry silently changes where every call to this menu starts. Mobile refuses
  // that deliberately (see the delete-the-entry-step refusal), and adding a step must not do it by
  // the back door.
  it("never MOVES an entry the menu already has", async () => {
    const wired: IvrFlow = {
      entryNodeId: "n_a",
      nodes: [{ id: "n_a", flow: "sales", isEntry: true, type: "play", config: {}, positionX: null, positionY: null }],
    };
    let put: IvrFlow | null = null;
    await addStepTo(wired, "sales", "play", "n_new", {
      get: async () => wired,
      put: async (f) => {
        put = f;
      },
    });
    expect(put!.entryNodeId).toBe("n_a");
    expect(put!.nodes.find((n) => n.id === "n_new")!.isEntry).toBe(false);
  });
});

describe("normalizeFlowName", () => {
  // The name goes into a URL path segment, into ivr_nodes.flow, and is what a phone number is
  // pointed at. A value that round-trips differently than it was typed would point a number at a
  // menu that does not exist.
  it("accepts the shape the existing menus use", () => {
    expect(normalizeFlowName("sales")).toBe("sales");
    expect(normalizeFlowName("  After Hours  ")).toBe("after_hours");
    expect(normalizeFlowName("out-of-hours")).toBe("out_of_hours");
  });

  it("refuses anything that would not survive a URL, rather than silently correcting it", () => {
    expect(normalizeFlowName("")).toBe("");
    expect(normalizeFlowName("   ")).toBe("");
    expect(normalizeFlowName("sales/main")).toBe("");
    expect(normalizeFlowName("sales?x=1")).toBe("");
    expect(normalizeFlowName("a".repeat(41))).toBe("");
  });
});

// A Hold step's callback line is optional: blank means the built-in wording, not an unfinished step.
describe("a Hold step's callback line", () => {
  it("is not flagged as unfinished when left blank", () => {
    const n = node("w", "wait", { audioAssetId: null, ttsText: "", allowCallbackStar: true, callbackKey: "1", nextNodeId: "ring1" });
    expect(incompleteReason(n)).toBeNull();
  });
});
