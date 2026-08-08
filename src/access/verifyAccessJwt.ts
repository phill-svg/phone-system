import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccessIdentity = {
  email: string;
};

export function createAccessVerifier(
  teamDomain: string,
  audience: string
): (token: string) => Promise<AccessIdentity | null> {
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));

  return async function verifyAccessJwt(token: string): Promise<AccessIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${teamDomain}`,
        audience,
      });
      if (typeof payload.email !== "string") return null;
      return { email: payload.email.toLowerCase() };
    } catch {
      return null;
    }
  };
}
