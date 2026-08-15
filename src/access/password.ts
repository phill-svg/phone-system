import { base64Encode, base64Decode } from "./crypto";

const ITERATIONS = 210000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

async function pbkdf2(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(plain), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(plain, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64Encode(salt)}$${base64Encode(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64Decode(parts[2]);
    expected = base64Decode(parts[3]);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await pbkdf2(plain, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// Cached dummy hash so POST /login can burn equivalent time on unknown emails,
// preventing timing-based account enumeration.
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("dummy-password-not-a-real-account");
  return dummyHashPromise;
}
