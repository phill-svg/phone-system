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
  IVR_NODE_TYPES,
  NEXT_FIELDS,
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
