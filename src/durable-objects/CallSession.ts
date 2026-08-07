import { DurableObject } from "cloudflare:workers";
import { reduce, type IvrCommand, type IvrEvent, type IvrState } from "../ivr/stateMachine";
import { renderTwiml } from "../twilio/twiml";
import { getBusinessHours } from "../db/settings";
import { isWithinBusinessHours } from "../ivr/businessHours";

type Env = {
  DB: D1Database;
};

type CallEvent = {
  callSid: string;
  from: string;
  to: string;
  digits: string | null;
  webhookUrl: string;
};

export class CallSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { callSid, from, to, digits, webhookUrl } = (await request.json()) as CallEvent;
    const allCommands: IvrCommand[] = [];
    const stored = await this.ctx.storage.get<IvrState>("state");
    let current: IvrState;

    if (!stored) {
      const schedule = await getBusinessHours(this.env.DB);
      const isAfterHours = !isWithinBusinessHours(schedule, new Date());

      await this.env.DB.prepare(
        "INSERT INTO calls (id, caller_number, called_number, started_at, is_after_hours) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(callSid, from, to, Date.now(), isAfterHours ? 1 : 0)
        .run();

      current = await this.applyEvent(callSid, { name: "INCOMING" }, { type: "CALL_INITIATED", isAfterHours }, allCommands);
      current = await this.applyEvent(callSid, current, { type: "GREETING_SPOKEN" }, allCommands);
    } else {
      const nextEvent: IvrEvent = digits ? { type: "DIGIT_RECEIVED", digit: digits } : { type: "GATHER_TIMED_OUT" };
      current = await this.applyEvent(callSid, stored, nextEvent, allCommands);
    }

    if (current.name === "ROUTE_STAFF") {
      allCommands.push({ type: "SPEAK", text: "Thanks, connecting you now." }, { type: "HANGUP" });
    } else if (current.name === "VOICEMAIL") {
      allCommands.push({ type: "HANGUP" });
    }

    await this.ctx.storage.put("state", current);

    const xml = renderTwiml(allCommands, { gatherAction: webhookUrl });
    return new Response(xml, { headers: { "Content-Type": "text/xml" } });
  }

  private async applyEvent(
    callSid: string,
    current: IvrState,
    event: IvrEvent,
    allCommands: IvrCommand[]
  ): Promise<IvrState> {
    const { state: next, commands } = reduce(current, event);
    allCommands.push(...commands);

    await this.env.DB.prepare("INSERT INTO call_events (call_id, ts, event_type, detail) VALUES (?, ?, ?, ?)")
      .bind(callSid, Date.now(), "state_transition", JSON.stringify({ event, next }))
      .run();

    if (next.name === "ROUTE_STAFF") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?").bind(next.tag, callSid).run();
    }
    if (next.name === "VOICEMAIL") {
      await this.env.DB.prepare("UPDATE calls SET ivr_path = ? WHERE id = ?").bind("voicemail", callSid).run();
    }

    return next;
  }
}
