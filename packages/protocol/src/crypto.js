/**
 * CopyMe protocol — key derivation and payload encryption.
 *
 * Zero dependencies and no build step, so the identical file runs in the
 * browser, in the VS Code extension worker, and in Node 18+. One
 * implementation, one thing to audit.
 *
 * A channel is { linkCode, channelId, authToken, epoch }.
 * An entry is  { v, epoch, deviceId, nonce, ciphertext, contentType, createdAt? }.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** Crockford base32 — no I, L, O or U, so codes survive being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PROTOCOL_VERSION = 1;

/** Domain separation. Distinct labels keep the three derived values unrelated. */
/** Domain separation labels. */
const LABEL = {
  channel: "copyme/v1/channel-id",
  auth: "copyme/v1/auth-token",
  aead: "copyme/v1/content-key",
};

/* ------------------------------------------------------------------ codes */

/**
 * A fresh link code: 160 bits of entropy as 8 groups of 4 base32 characters.
 * Codes are always generated, never chosen, which is what lets us skip key
 * stretching — there is no low-entropy input to stretch.
 */
export function generateLinkCode() {
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

export function normalizeLinkCode(code) {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Accepts only well-formed generated codes. Refusing free text removes the
 * offline brute-force path outright rather than trying to score entropy.
 */
export function isValidLinkCode(code) {
  const n = normalizeLinkCode(code);
  return /^CM[0-9A-HJKMNP-TV-Z]{32}$/.test(n);
}

/* ------------------------------------------------------------ derivation */

async function hkdf(code, label, bits) {
  const master = await crypto.subtle.importKey("raw", te.encode(code), "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("copyme/v1/salt"), info: te.encode(label) },
    master,
    bits,
  );
  return new Uint8Array(derived);
}

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveChannel(linkCode, epoch = 0) {
  if (!isValidLinkCode(linkCode)) throw new Error("That is not a valid CopyMe link code.");
  const normalized = normalizeLinkCode(linkCode);
  return {
    linkCode: normalized,
    channelId: b64url(await hkdf(normalized, LABEL.channel, 128)),
    authToken: b64url(await hkdf(normalized, LABEL.auth, 256)),
    epoch,
  };
}

async function contentKey(linkCode, epoch) {
  const bytes = await hkdf(normalizeLinkCode(linkCode), `${LABEL.aead}/${epoch}`, 256);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/* ------------------------------------------------------------ encryption */

/**
 * Binding the channel, epoch and origin device into the AEAD means a captured
 * payload cannot be replayed into a different channel or a rotated epoch.
 */
function aad(channelId, epoch, deviceId) {
  return te.encode(`copyme/v1|${channelId}|${epoch}|${deviceId}`);
}

export async function encryptEntry(plaintext, channel, deviceId) {
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

export async function decryptEntry(entry, channel) {
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
export function newDeviceId() {
  return b64url(crypto.getRandomValues(new Uint8Array(8)));
}
