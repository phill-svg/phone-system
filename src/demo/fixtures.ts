// Invented data served to the App Review demo account instead of the real business inbox.
//
// Why this exists: conversations, call history and contacts in this app are business-wide, not
// per-user, so ANY login -- including the reviewer's -- sees real customers by name, number and
// message body. That is real people's data in front of a third party, and it is what ends up in
// the App Store screenshots too. The demo account gets this parallel dataset instead.
//
// Every phone number below comes from ACMA's ranges reserved for fiction (mobiles 0491 570 xxx,
// landlines (0x) 5550 xxxx), so nothing a reviewer taps can dial or text a real person.

export type DemoContact = {
  id: number;
  name: string;
  company: string | null;
  phone: string;
  phone_normalized: string;
  created_at: number;
  updated_at: number;
};

export type DemoCall = {
  id: string;
  caller_number: string;
  called_number: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  direction: "inbound" | "outbound";
  recording_sid: string | null;
  recording_url: string | null;
  recording_duration: number | null;
  transcription: string | null;
  call_transcript: string | null;
  disposition: string | null;
  notes: string | null;
};

export type DemoConversation = {
  number: string;
  name: string | null;
  last_body: string;
  last_ts: number;
  unread: number;
};

export type DemoMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  ts: number;
  status: string;
};

// The business's own numbers. Public information, and already on screen in the app.
const MAIN_LINE = "+61261059771";

// ACMA fictitious numbers. Keep every demo number inside these ranges.
const MOBILE = {
  marion: "+61491570006",
  dev: "+61491570156",
  louise: "+61491570157",
  harry: "+61491570158",
  jo: "+61491570159",
  sam: "+61491570110",
  tanya: "+61491570313",
};
const LANDLINE = {
  cafe: "+61255501234",
  dental: "+61255504417",
  property: "+61255508890",
};

const MESSENGER_PEER = "messenger:demo-fb-1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function digitsOf(e164: string): string {
  return e164.replace(/\D/g, "");
}

export function demoContacts(now: number): DemoContact[] {
  const people: [string, string | null, string][] = [
    ["Marion Kelly", null, MOBILE.marion],
    ["Dev Patel", null, MOBILE.dev],
    ["Louise Tran", "Tran Property Care", MOBILE.louise],
    ["Harry Nguyen", null, MOBILE.harry],
    ["Jo Whitfield", null, MOBILE.jo],
    ["Sam Okafor", null, MOBILE.sam],
    ["Tanya Brooks", null, MOBILE.tanya],
    ["Braddon Cafe", "Braddon Cafe", LANDLINE.cafe],
    ["Kingston Dental", "Kingston Dental", LANDLINE.dental],
    ["Woden Property Group", "Woden Property Group", LANDLINE.property],
  ];
  return people.map(([name, company, phone], i) => ({
    id: i + 1,
    name,
    company,
    phone,
    phone_normalized: digitsOf(phone),
    created_at: now - (30 - i) * DAY,
    updated_at: now - (30 - i) * DAY,
  }));
}

// Times are relative to the request, so the demo never looks abandoned -- a reviewer opening it in
// three months still sees "this morning", not a wall of stale dates.
export function demoCalls(now: number): DemoCall[] {
  const inbound = (
    id: string,
    from: string,
    minutesAgo: number,
    durationSec: number,
    extra: Partial<DemoCall> = {}
  ): DemoCall => ({
    id,
    caller_number: from,
    called_number: MAIN_LINE,
    started_at: now - minutesAgo * MINUTE,
    ended_at: now - minutesAgo * MINUTE + durationSec * 1000,
    status: "completed",
    direction: "inbound",
    recording_sid: null,
    recording_url: null,
    recording_duration: null,
    transcription: null,
    call_transcript: null,
    disposition: null,
    notes: null,
    ...extra,
  });
  const outbound = (id: string, to: string, minutesAgo: number, durationSec: number): DemoCall => ({
    ...inbound(id, MAIN_LINE, minutesAgo, durationSec),
    caller_number: MAIN_LINE,
    called_number: to,
    direction: "outbound",
  });

  return [
    inbound("DEMO-c01", MOBILE.marion, 42, 214, {
      call_transcript:
        "Hi, it is Marion Kelly. We have got ants right through the kitchen again. -- No problem, we can get someone out Thursday morning. -- Thursday is great, thank you.",
    }),
    outbound("DEMO-c02", LANDLINE.cafe, 95, 168),
    inbound("DEMO-c03", MOBILE.dev, 150, 0, {
      status: "no-answer",
      ended_at: now - 150 * MINUTE + 24_000,
      transcription:
        "Hi, Dev Patel here. Just following up on the quote for the cafe fit-out. Give me a call back when you get a chance, thanks.",
    }),
    inbound("DEMO-c04", MOBILE.louise, 6 * 60, 305),
    outbound("DEMO-c05", MOBILE.harry, 8 * 60, 96),
    inbound("DEMO-c06", LANDLINE.dental, 26 * 60, 141),
    inbound("DEMO-c07", MOBILE.jo, 28 * 60, 0, {
      status: "no-answer",
      ended_at: now - 28 * 60 * MINUTE + 31_000,
      transcription:
        "Hello, this is Jo Whitfield calling about the termite inspection report. Could someone email it through? Thanks so much.",
    }),
    outbound("DEMO-c08", MOBILE.tanya, 30 * 60, 253),
    inbound("DEMO-c09", LANDLINE.property, 2 * 24 * 60, 187),
    outbound("DEMO-c10", MOBILE.sam, 2 * 24 * 60 + 90, 62),
    inbound("DEMO-c11", MOBILE.marion, 3 * 24 * 60, 119),
    inbound("DEMO-c12", MOBILE.dev, 4 * 24 * 60, 0, { status: "busy", ended_at: null }),
  ];
}

// Each thread's messages, newest last. The conversation list is derived from these, so the two
// can never disagree about the last message or its timestamp.
function demoThreads(
  now: number
): { number: string; name: string | null; unread: number; messages: DemoMessage[] }[] {
  const msg = (
    id: string,
    direction: "inbound" | "outbound",
    body: string,
    minutesAgo: number
  ): DemoMessage => ({
    id,
    direction,
    body,
    ts: now - minutesAgo * MINUTE,
    status: direction === "outbound" ? "delivered" : "received",
  });

  return [
    {
      number: MOBILE.marion,
      name: null,
      unread: 0,
      messages: [
        msg("DEMO-m01", "inbound", "Hi, are you able to do a general pest spray this week?", 190),
        msg("DEMO-m02", "outbound", "Hi Marion, yes we can. Would Thursday morning between 8 and 10 suit?", 185),
        msg("DEMO-m03", "inbound", "Thursday morning is perfect, thank you!", 181),
        msg("DEMO-m04", "outbound", "Booked in. We will send a reminder the day before.", 178),
      ],
    },
    {
      number: MOBILE.dev,
      name: null,
      unread: 2,
      messages: [
        msg("DEMO-m05", "outbound", "Hi Dev, the quote for the cafe fit-out is in your email.", 320),
        msg("DEMO-m06", "inbound", "Got it, thanks. One question about the warranty period.", 300),
        msg("DEMO-m07", "inbound", "Is it 6 or 12 months on the treatment?", 298),
      ],
    },
    {
      number: MESSENGER_PEER,
      name: "Alex Rivera",
      unread: 1,
      messages: [
        msg("DEMO-m08", "inbound", "Hi! Do you treat wasp nests in the roof?", 460),
        msg("DEMO-m09", "outbound", "We do. Roughly how high up is it, and whereabouts are you?", 452),
        msg("DEMO-m10", "inbound", "Second storey eave, out in Belconnen.", 448),
      ],
    },
    {
      number: LANDLINE.cafe,
      name: null,
      unread: 0,
      messages: [
        msg("DEMO-m11", "inbound", "Morning - can we move the monthly service to next Tuesday?", 1500),
        msg("DEMO-m12", "outbound", "No problem, moved to Tuesday 7am before you open.", 1490),
      ],
    },
    {
      number: MOBILE.louise,
      name: null,
      unread: 0,
      messages: [
        msg("DEMO-m13", "outbound", "Hi Louise, the tech is running about 15 minutes late, sorry.", 2900),
        msg("DEMO-m14", "inbound", "All good, thanks for letting me know.", 2880),
      ],
    },
    {
      number: LANDLINE.dental,
      name: null,
      unread: 0,
      messages: [
        msg("DEMO-m15", "inbound", "Could we get a copy of the last inspection certificate?", 4200),
        msg("DEMO-m16", "outbound", "Sent through just now. Let us know if it does not arrive.", 4180),
      ],
    },
    {
      number: MOBILE.jo,
      name: null,
      unread: 0,
      messages: [
        msg("DEMO-m17", "inbound", "Thanks for today, the team were great.", 5600),
        msg("DEMO-m18", "outbound", "Thanks Jo, much appreciated. See you at the next service.", 5590),
      ],
    },
  ];
}

export function demoConversations(now: number): DemoConversation[] {
  return demoThreads(now)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      return { number: t.number, name: t.name, last_body: last.body, last_ts: last.ts, unread: t.unread };
    })
    .sort((a, b) => b.last_ts - a.last_ts);
}

export function demoThread(now: number, peer: string): DemoMessage[] {
  return demoThreads(now).find((t) => t.number === peer)?.messages ?? [];
}

export function demoCall(now: number, id: string): DemoCall | undefined {
  return demoCalls(now).find((c) => c.id === id);
}
