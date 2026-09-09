
// Workers run in UTC, so a bare toLocaleString renders a 9am Canberra call as 11pm the previous
// day -- and a callback request as though it came in last night. Every admin page that renders a
// time SERVER-SIDE goes through here; voicemail.ts and clientErrors.ts already passed the same
// option bag inline, which is what made the pages that did not an omission rather than a choice.
//
// Deliberately not everything that formats a time. The clock code inside phone.ts's template
// literal runs in the BROWSER, which is already in Canberra, and businessHours.ts / dateRules.ts
// hold their own TIME_ZONE because theirs is a routing decision rather than a label -- pointing
// those at a helper in src/html/ would be the wrong dependency direction.
export const BUSINESS_TIME_ZONE = "Australia/Sydney";

export function formatSydney(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", { timeZone: BUSINESS_TIME_ZONE });
}
