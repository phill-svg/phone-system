import {
  orderNodes,
  outgoingIds,
  removeNode,
  nodeSummary,
  blankConfigFor,
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

  // PUT /api/ivr/flows/:flow is a full delete-and-reinsert, so anything this app does not carry
  // back is destroyed. positionX/positionY are the WEB editor's canvas coordinates and are never
  // read here -- losing them would flatten every node onto the origin the next time the web editor
  // was opened, which is a mess nobody would connect to a phone edit.
  it("preserves the web canvas positions it never reads", () => {
    const after = removeNode(FLOW, "cb");
    for (const n of after.nodes) {
      expect(n.positionX).toBe(10);
      expect(n.positionY).toBe(20);
    }
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
