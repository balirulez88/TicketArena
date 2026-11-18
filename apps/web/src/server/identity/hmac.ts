const encoder = new TextEncoder();

// Web Crypto (not node:crypto) so the same code runs in the proxy and in route handlers.
function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Hex HMAC-SHA256 of `message` under `secret`. */
export async function signHex(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret, "sign"),
    encoder.encode(message),
  );
  return toHex(new Uint8Array(signature));
}

/** `true` when `signatureHex` is the HMAC of `message`; compared in constant time. */
export async function verifyHex(
  secret: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = fromHex(signatureHex);
  if (signature === undefined) {
    return false;
  }
  // subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret, "verify"),
    signature,
    encoder.encode(message),
  );
}
