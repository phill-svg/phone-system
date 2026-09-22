// The one place that decides what a call-blocklist entry IS.
//
// The list has exactly one consumer: `src/worker.ts` compares it LITERALLY against `params.From`
// on an inbound call (`blocklist.includes(params.From)`). Twilio reports that in E.164. So an entry
// in any other shape blocks nobody, forever, while sitting on the screen looking exactly like an
// entry that works -- which is the failure this module exists to make impossible.
//
// It lives on the SERVER because both clients write this list and they disagreed: the web form
// posted raw text, the handset normalised, and a half-typed number was refused on one surface and
// committed on the other. Clients still check locally to decide whether Save is enabled, but this
// is the rule that holds -- a client that skips it gets a 400 naming the entry, not a silently
// useless list.
//
// Deliberately NOT accepting alphanumeric senders ("SERVICE-NSW"). Those are SMS sender IDs; a
// voice call's From is never one, so storing it would add a row that can never match.

// Whether the digits are a COMPLETE Australian number rather than a prefix of one.
//
// Prefix-freedom, the same rule as the mobile schedule editor's TimeField: no digit can be
// appended to make another valid number. Without it "02 6105 977" -- a landline one keystroke short
// -- is stored as +6126105977 and blocks nobody.
function isCompleteAuNational(national: string): boolean {
  return (
    /^4\d{8}$/.test(national) || // mobile
    /^[2378]\d{8}$/.test(national) || // landline
    // (?!00) because 1300 is carved OUT of the 13 range. Without it "130012" -- the first six
    // digits of every 1300 number -- reads as a finished 13xxxx number.
    /^13(?!00)\d{4}$/.test(national) || // 13xxxx
    /^1[38]00\d{6}$/.test(national) // 1300/1800
  );
}

// E.164's own limit: at most 15 digits including the country code, and nothing shorter than 8 is a
// dialable number anywhere.
const MIN_INTERNATIONAL_DIGITS = 9;
const MAX_E164_DIGITS = 15;

// The entry as it must be stored, or null if it is not one.
//
// Accepts what an admin actually types -- "0400 123 456", "+61 400 123 456", "(02) 6105 9771",
// "0400.123.456" -- because separators vary by where the number was copied from, and a rule that
// refuses a non-breaking space is a rule that silently stores nothing useful.
export function blocklistNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A letter means this is not a phone number. Rejected rather than stored verbatim: the only
  // consumer compares against a voice call's From, which is always digits.
  if (/[a-z]/i.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length > MAX_E164_DIGITS) return null;

  // A leading "+" means the number is already international; a leading 0 is the AU trunk prefix.
  // Tested on the DIGITS, not the raw string, so "+ 61 2 ..." cannot dodge the Australian rules by
  // putting a space after the plus.
  const international = trimmed.startsWith("+");
  const national = digits.startsWith("61") ? digits.slice(2) : null;

  if (!international && !digits.startsWith("61")) {
    // Typed the way an Australian dials: a trunk 0, or a 13/1300/1800 number that carries none.
    const local = digits.startsWith("0") ? digits.slice(1) : digits;
    return isCompleteAuNational(local) ? `+61${local}` : null;
  }
  if (national !== null) return isCompleteAuNational(national) ? `+61${national}` : null;

  // Any other country. There is no per-country length table here, so the only claim made is that
  // this is long enough to be a number rather than a prefix.
  return digits.length >= MIN_INTERNATIONAL_DIGITS ? `+${digits}` : null;
}
