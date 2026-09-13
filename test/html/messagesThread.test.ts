import { describe, expect, it, vi } from "vitest";
import { renderMessagesPage } from "../../src/html/pages/messages";

// loadThread is polled every 5s. A response that lands after staff have opened a DIFFERENT thread
// used to render one customer's messages under the other customer's header. The REAL emitted
// function is run against a stub api whose response is released by hand.
function harness() {
  const html = renderMessagesPage();
  const line = html.split("\n").find((l) => l.trimStart().startsWith("function loadThread("));
  if (!line) throw new Error("no emitted function loadThread");
  const renderThread = vi.fn();
  let release: (msgs: unknown) => void = () => {};
  const api = () => new Promise((resolve) => (release = resolve));
  const page = new Function(
    "api",
    "renderThread",
    `var current = null;
     ${line}
     return { open: function (n) { current = n; }, loadThread: loadThread };`
  )(api, renderThread) as { open: (n: string) => void; loadThread: () => void };
  return { page, renderThread, release: (msgs: unknown) => release(msgs) };
}

describe("an open thread's poll (web)", () => {
  it("ignores a response for a thread that is no longer open", async () => {
    const { page, renderThread, release } = harness();
    page.open("+61400000001");
    page.loadThread();
    page.open("+61400000002");
    release([{ body: "for the first customer" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(renderThread).not.toHaveBeenCalled();
  });

  it("renders a response for the thread still open", async () => {
    const { page, renderThread, release } = harness();
    page.open("+61400000001");
    page.loadThread();
    release([{ body: "hello" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(renderThread).toHaveBeenCalledWith([{ body: "hello" }]);
  });
});
