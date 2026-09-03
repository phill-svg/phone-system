// Which of the business's numbers a message or call actually goes out from.
//
// Pure so the fallback order is testable: a remembered choice wins, but ONLY while that number is
// still in the list -- a number that gets deleted, or has its voice/SMS capability turned off,
// must not keep being used just because the device remembers picking it once. Otherwise fall back
// to the business default for the channel, then to whatever is available.
export function resolveSendingNumber<T extends { e164: string }>(
  options: T[],
  remembered: string | null,
  isDefault: (n: T) => boolean
): string | undefined {
  if (remembered && options.some((n) => n.e164 === remembered)) return remembered;
  return options.find(isDefault)?.e164 ?? options[0]?.e164;
}
