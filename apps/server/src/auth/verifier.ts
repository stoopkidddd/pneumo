import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const parameters = { N: 16_384, r: 8, p: 1 } as const;

export interface AuthVerifier {
  alg: "scrypt";
  N: 16_384;
  r: 8;
  p: 1;
  salt: string;
  hash: string;
}

function hashAuthKey(authKey: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(Buffer.from(authKey, "base64url"), salt, 32, parameters, (error, hash) => {
    if (error) reject(error);
    else resolve(hash);
  });
  return promise;
}

export async function createVerifier(authKey: string): Promise<AuthVerifier> {
  const salt = randomBytes(16);
  const hash = await hashAuthKey(authKey, salt);
  return {
    alg: "scrypt",
    ...parameters,
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  };
}

export async function verifyAuthKey(authKey: string, verifier: AuthVerifier): Promise<boolean> {
  const hash = await hashAuthKey(authKey, Buffer.from(verifier.salt, "base64url"));
  return timingSafeEqual(hash, Buffer.from(verifier.hash, "base64url"));
}
