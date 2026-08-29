/**
 * CopyMe protocol — key derivation and payload encryption.
 *
 * Zero dependencies and no build step, so the identical file runs in the
 * browser, in the VS Code extension worker, and in Node 18+. One
 * implementation, one thing to audit.
 *
 * Two ways to open a channel, both ending at the same 32-byte secret:
 *
 *   a name + password   stretched with PBKDF2, for pairing you can say aloud
 *   a generated code     160 bits of entropy, for when nothing may be guessed
 *
 * Everything downstream — channel id, auth token, content key — is HKDF from
 * that secret, so the rest of the protocol never knows which route you took.
 *
 * A channel is { secret, channelId, authToken, epoch, label }.
 * An entry is  { v, epoch, deviceId, nonce, ciphertext, contentType, createdAt? }.
 */

const te = new TextEncoder();
const td = new TextDecoder();

/** Crockford base32 — no I, L, O or U, so codes survive being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PROTOCOL_VERSION = 1;

/**
 * A human-chosen password has far less entropy than a generated code, so each
 * guess must be made expensive. At 2,000,000 the derivation costs a fraction of
 * a second on a modern machine and is paid once, at pairing — never per entry,
 * because the stretched secret is what gets stored.
 */
export const PBKDF2_ITERATIONS = 2_000_000;

export const MIN_PASSWORD_LENGTH = 8;
export const MIN_NAME_LENGTH = 3;

/** Domain separation labels. */
const LABEL = {
  channel: "copyme/v1/channel-id",
  auth: "copyme/v1/auth-token",
  aead: "copyme/v1/content-key",
};

/* ------------------------------------------------------------- primitives */

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

async function hkdf(secretBytes, label, bits) {
  const master = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("copyme/v1/salt"), info: te.encode(label) },
    master,
    bits,
  );
  return new Uint8Array(derived);
}

/* ------------------------------------------------------------------ codes */

/** 160 bits of entropy as eight groups of four base32 characters. */
export function generateLinkCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0, acc = 0, out = "";
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

export function isValidLinkCode(code) {
  return /^CM[0-9A-HJKMNP-TV-Z]{32}$/.test(normalizeLinkCode(code));
}

/* ------------------------------------------------------- names, passwords */

/** Case and spacing must not change which channel you land in. */
export function normalizeChannelName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Passwords people reach for first, and that an attacker tries first too. */
const COMMON = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyui", "qwerty123", "iloveyou", "welcome1", "admin123", "letmein1",
  "abc12345", "11111111", "00000000", "changeme", "trustno1", "sunshine",
]);

/**
 * A rough, honest read on a password. Not a security boundary — the stretching
 * is — but it steers people away from the guesses an attacker starts with.
 */
export function passwordStrength(password) {
  const pw = password ?? "";
  const problems = [];

  if (pw.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (COMMON.has(pw.toLowerCase())) {
    problems.push("That is one of the first passwords anyone would try.");
  }
  if (/^\d+$/.test(pw) && pw.length < 12) {
    problems.push("Digits alone are quick to guess — add words or symbols.");
  }
  if (/^(.)\1+$/.test(pw)) {
    problems.push("Repeating one character gives almost nothing to guess against.");
  }

  // Length buys far more resistance than character variety does: a long spoken
  // passphrase beats a short one peppered with symbols, and is easier to say
  // down the phone to your other laptop.
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  let score = 0;
  if (pw.length >= MIN_PASSWORD_LENGTH) score = 1;
  if (pw.length >= 12 || (pw.length >= 10 && variety >= 3)) score = 2;
  if (pw.length >= 20 || (pw.length >= 14 && variety >= 3)) score = 3;
  if (problems.length) score = 0;

  return {
    score,
    label: ["too weak", "workable", "good", "strong"][score],
    problems,
    ok: problems.length === 0,
  };
}

/** Returns a message describing what is wrong, or null when the pair is usable. */
export function validatePairing(name, password) {
  if (normalizeChannelName(name ?? "").length < MIN_NAME_LENGTH) {
    return `Channel name needs at least ${MIN_NAME_LENGTH} characters.`;
  }
  const strength = passwordStrength(password);
  return strength.ok ? null : strength.problems[0];
}

/* ------------------------------------------------------------ derivation */

/** Builds a channel from an already-derived 32-byte secret. */
async function channelFromSecret(secretBytes, epoch, label) {
  return {
    secret: b64url(secretBytes),
    channelId: b64url(await hkdf(secretBytes, LABEL.channel, 128)),
    authToken: b64url(await hkdf(secretBytes, LABEL.auth, 256)),
    epoch,
    label,
  };
}

/**
 * Name plus password. The name doubles as the PBKDF2 salt, so two people
 * choosing the same password land in different channels, and a precomputed
 * table would have to be built per name.
 */
export async function channelFromPassphrase(name, password, epoch = 0) {
  const problem = validatePairing(name, password);
  if (problem) throw new Error(problem);

  const clean = normalizeChannelName(name);
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: te.encode(`copyme/v1/channel/${clean}`),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return channelFromSecret(new Uint8Array(bits), epoch, clean);
}

/** A generated code already carries full entropy, so no stretching is needed. */
export async function channelFromCode(linkCode, epoch = 0) {
  if (!isValidLinkCode(linkCode)) throw new Error("That is not a valid CopyMe link code.");
  const normalized = normalizeLinkCode(linkCode);
  const secret = await hkdf(te.encode(normalized), "copyme/v1/code-secret", 256);
  return channelFromSecret(secret, epoch, normalized);
}

/** Rebuilds a channel from what was stored, with no derivation cost. */
export async function channelFromStored(stored) {
  return channelFromSecret(unb64url(stored.secret), stored.epoch ?? 0, stored.label ?? "");
}

async function contentKey(secretB64, epoch) {
  const bytes = await hkdf(unb64url(secretB64), `${LABEL.aead}/${epoch}`, 256);
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
  const key = await contentKey(channel.secret, channel.epoch);
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
  const key = await contentKey(channel.secret, entry.epoch);
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
