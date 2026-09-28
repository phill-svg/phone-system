import { describe, expect, it } from "vitest";
import { renderPhonePage } from "../../src/html/pages/phone";

// Reported 2026-09-28 as "the desktop session keeps expiring every couple minutes". The session was
// fine and heartbeats were landing: a network blip made two beats THROW, the page printed "Session
// expired -- reload", and nothing ever took it back. The REAL emitted heartbeat code runs here
// against a scripted fetch, so a regression in phone.ts has to reach this test.
function harness() {
  const html = renderPhonePage("phill@b.com");
  const code = /(var heartbeatFailures = 0;[\s\S]*?)\n\s*setInterval\(sendHeartbeat/.exec(html)?.[1];
  if (!code) throw new Error("could not find the heartbeat code in the emitted phone script");
  const el = { textContent: "Registered", classList: { toggle() {}, contains: () => false, remove() {} } };
  const replies: Array<() => Promise<unknown>> = [];
  const fetch = () => (replies.shift() ?? (() => Promise.resolve({ ok: true, status: 200 })))();
  const run = new Function(
    "document",
    "fetch",
    `var noteSaved = null, noteTimer = null;
     var device = { state: 'registered' };
     function setDeviceStatusText(text) { document.getElementById('device-status').textContent = text; }
     // The pre-fix page's own helper, so reverting phone.ts fails on BEHAVIOUR rather than on a
     // missing function (which made the old code look like it cleared its warning).
     function sessionExpiredHint() { setDeviceStatusText('Session expired -- reload (Ctrl+Shift+R) to sign back in.'); }
     ${code}
     return { beat: sendHeartbeat };`
  );
  const page = run({ getElementById: () => el }, fetch) as { beat: () => void };
  const beat = async (reply: () => Promise<unknown>) => {
    replies.push(reply);
    page.beat();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { el, beat };
}
const dropped = () => Promise.reject(new TypeError("Failed to fetch"));
const ok = () => Promise.resolve({ ok: true, status: 200 });

describe("the softphone heartbeat status line", () => {
  it("calls a dropped connection a dropped connection, not an expired session", async () => {
    const { el, beat } = harness();
    await beat(dropped);
    await beat(dropped);
    expect(el.textContent).not.toMatch(/expired/i);
    expect(el.textContent).toMatch(/connection/i);
  });

  it("clears the warning as soon as a heartbeat gets through again", async () => {
    const { el, beat } = harness();
    await beat(dropped);
    await beat(dropped);
    expect(el.textContent).not.toBe("Registered");
    await beat(ok);
    expect(el.textContent).toBe("Registered");
  });

  it("says signed out on a 401", async () => {
    const { el, beat } = harness();
    await beat(() => Promise.resolve({ ok: false, status: 401 }));
    expect(el.textContent).toMatch(/signed out/i);
  });
});
