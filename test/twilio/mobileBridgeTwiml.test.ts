import { describe, it, expect } from "vitest";
import { renderBridgeToCustomer, renderAbandonToVoicemail } from "../../src/twilio/conferenceTwiml";

const OPTS = {
  to: "+61402430107",
  callerId: "+61261059771",
  recordingStatusCallbackUrl: "https://example.com/webhooks/twilio/recording-status?callSid=CA1&whsec=s",
};

describe("renderBridgeToCustomer", () => {
  // The defect this exists for: an `action` pointed at a status-callback endpoint, which answers
  // with a plain "ok". A Dial action URL must return TwiML, so Twilio played "an application error
  // has occurred" to the staff member at the end of every single call-via-mobile call.
  it("carries no action attribute — a Dial action must return TwiML, and we have nothing to say", () => {
    const xml = renderBridgeToCustomer(OPTS);
    expect(xml).not.toContain("action=");
    expect(xml).not.toContain("/webhooks/twilio/status");
  });

  it("dials the customer with the business number as caller ID", () => {
    const xml = renderBridgeToCustomer(OPTS);
    expect(xml).toContain("<Number>+61402430107</Number>");
    expect(xml).toContain('callerId="+61261059771"');
  });

  // Without it the staff member hears silence while the customer's phone rings.
  it("answers on bridge so the staff member hears real ringback", () => {
    expect(renderBridgeToCustomer(OPTS)).toContain('answerOnBridge="true"');
  });

  it("records by default, and not when recording is off", () => {
    expect(renderBridgeToCustomer(OPTS)).toContain('record="record-from-answer"');
    expect(renderBridgeToCustomer({ ...OPTS, record: false })).not.toContain("record=");
  });

  it("is well-formed TwiML: a single Response wrapping one Dial", () => {
    const xml = renderBridgeToCustomer(OPTS);
    expect(xml).toContain("<Response>");
    expect(xml).toContain("</Response>");
    expect(xml.match(/<Dial/g)).toHaveLength(1);
    expect(xml.match(/<\/Dial>/g)).toHaveLength(1);
  });
});

describe("renderAbandonToVoicemail", () => {
  it("hangs up and nothing else — the customer must never be dialled into a voicemail greeting", () => {
    const xml = renderAbandonToVoicemail();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Dial");
  });
});
