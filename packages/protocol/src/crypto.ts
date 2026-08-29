/**
 * CopyMe protocol — key derivation and payload encryption.
 *
 * Zero dependencies, and identical on every client, so there is exactly one
 * implementation to audit. Runs anywhere WebCrypto exists: browsers, the VS
 * Code extension worker, and Node 18+.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** Crockford base32 — no I, L, O or U, so codes survive being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PROTOCOL_VERSION = 1;

/** Domain separation. Distinct labels keep the three derived values unrelated. */
const LABEL = {
  channel: "copyme/v1/channel-id",
  auth: "copyme/v1/auth-token",
  aead: "copyme/v1/content-key",
} as const;

export interface Channel {
  /** The link code itself. Never leaves the device. */
  linkCode: string;
  /** Public-ish identifier the relay routes on. */
  channelId: string;
  /** Bearer token proving membership to the relay. */
  authToken: string;
  /** Bumped on revocation so removed devices can no longer decrypt. */
  epoch: number;
}

export interface Entry {
  v: number;
  epoch: number;
  /** Cleartext so a receiver can rebuild the AAD and ignore its own echoes. */
  deviceId: string;
  nonce: string;
  ciphertext: string;
  contentType: string;
  createdAt?: number;
}

/* ------------------------------------------------------------------ codes */

/**
 * A fresh link code: 160 bits of entropy as 8 groups of 4 base32 characters.
 * Codes are always generated, never chosen, which is what lets us skip key
 * stretching — there is no low-entropy input to stretch.
 */
export function generateLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return "CM-" + (out.match(/.{4}/g) ?? []).join("-");
}

export function normalizeLinkCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Accepts only well-formed generated codes. Refusing free text removes the
 * offline brute-force path outright rather than trying to score entropy.
 */
export function isValidLinkCode(code: string): boolean {
  const n = normalizeLinkCode(code);
  return /^CM[0-9A-HJKMNP-TV-Z]{32}$/.test(n);
}

/* ------------------------------------------------------------ derivation */

async function hkdf(code: string, label: string, bits: number): Promise<Uint8Array> {
  const master = await crypto.subtle.importKey("raw", te.encode(code), "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("copyme/v1/salt"), info: te.encode(label) },
    master,
    bits,
  );
  return new Uint8Array(derived);
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveChannel(linkCode: string, epoch = 0): Promise<Channel> {
  if (!isValidLinkCode(linkCode)) throw new Error("That is not a valid CopyMe link code.");
  const normalized = normalizeLinkCode(linkCode);
  return {
    linkCode: normalized,
    channelId: b64url(await hkdf(normalized, LABEL.channel, 128)),
    authToken: b64url(await hkdf(normalized, LABEL.auth, 256)),
    epoch,
  };
}

async function contentKey(linkCode: string, epoch: number): Promise<CryptoKey> {
  const bytes = await hkdf(normalizeLinkCode(linkCode), `${LABEL.aead}/${epoch}`, 256);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/* ------------------------------------------------------------ encryption */

/**
 * Binding the channel, epoch and origin device into the AEAD means a captured
 * payload cannot be replayed into a different channel or a rotated epoch.
 */
function aad(channelId: string, epoch: number, deviceId: string): Uint8Array {
  return te.encode(`copyme/v1|${channelId}|${epoch}|${deviceId}`);
}

export async function encryptEntry(
  plaintext: string,
  channel: Channel,
  deviceId: string,
): Promise<Entry> {
  const key = await contentKey(channel.linkCode, channel.epoch);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(channel.channelId, channel.epoch, deviceId) },
    key,
    te.encode(plaintext),
  );
  return {
    v: PROTOCOL_VERSION,
    epoch: channel.epoch,
    deviceId,
    nonce: b64url(nonce),
    ciphertext: b64url(new Uint8Array(sealed)),
    contentType: "text/plain",
  };
}

export async function decryptEntry(entry: Entry, channel: Channel): Promise<string> {
  if (entry.v !== PROTOCOL_VERSION) throw new Error(`Unsupported entry version ${entry.v}.`);
  if (entry.epoch !== channel.epoch) throw new Error("Entry belongs to a revoked epoch.");
  const key = await contentKey(channel.linkCode, entry.epoch);
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64url(entry.nonce),
      additionalData: aad(channel.channelId, entry.epoch, entry.deviceId),
    },
    key,
    unb64url(entry.ciphertext),
  );
  return td.decode(opened);
}

/** Stable per-install id, used to ignore our own entries and stop sync loops. */
export function newDeviceId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(8)));
}
