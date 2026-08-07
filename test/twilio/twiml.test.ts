import { describe, expect, it } from "vitest";
import { renderTwiml } from "../../src/twilio/twiml";
import type { IvrCommand } from "../../src/ivr/stateMachine";

const GATHER_ACTION = "https://example.com/webhooks/twilio";

describe("renderTwiml", () => {
  it("renders a SPEAK command as <Say>", () => {
    const commands: IvrCommand[] = [{ type: "SPEAK", text: "Hello there" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello there</Say></Response>');
  });

  it("renders a GATHER command as <Gather> wrapping a <Say>", () => {
    const commands: IvrCommand[] = [{ type: "GATHER", prompt: "Press 1 or 2", validDigits: "12" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Gather action="${GATHER_ACTION}" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true">` +
        "<Say>Press 1 or 2</Say>" +
        "</Gather>" +
        "</Response>"
    );
  });

  it("renders a HANGUP command as <Hangup/>", () => {
    const commands: IvrCommand[] = [{ type: "HANGUP" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it("renders an ANSWER command as nothing (Twilio auto-answers)", () => {
    const commands: IvrCommand[] = [{ type: "ANSWER" }, { type: "SPEAK", text: "Hi" }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi</Say></Response>');
  });

  it("combines multiple commands into one Response, in order", () => {
    const commands: IvrCommand[] = [
      { type: "SPEAK", text: "This call may be recorded." },
      { type: "GATHER", prompt: "Press 1 for sales", validDigits: "1" },
    ];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        "<Say>This call may be recorded.</Say>" +
        `<Gather action="${GATHER_ACTION}" method="POST" input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true">` +
        "<Say>Press 1 for sales</Say>" +
        "</Gather>" +
        "</Response>"
    );
  });

  it("XML-escapes special characters in spoken text", () => {
    const commands: IvrCommand[] = [{ type: "SPEAK", text: `Bob & Jane's <shop> "special"` }];
    const xml = renderTwiml(commands, { gatherAction: GATHER_ACTION });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Bob &amp; Jane&apos;s &lt;shop&gt; &quot;special&quot;</Say></Response>'
    );
  });
});
