// Minimal ambient types for the node:crypto subset used by the break-glass
// format-compat test. This is a Workers project whose tsconfig deliberately
// excludes @types/node; the break-glass script's Node hashing is mirrored in
// one test to lock the hash-format contract, so we type only what that test uses.
declare module "node:crypto" {
  export function randomBytes(size: number): Uint8Array & { toString(encoding: string): string };
  export function pbkdf2Sync(
    password: string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string
  ): { toString(encoding: string): string };
}
