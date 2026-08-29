/**
 * CopyMe smoke test.
 *
 * Run with no arguments to verify the crypto in isolation:
 *     node scripts/smoke.mjs
 *
 * Point it at a running relay to verify the full round trip:
 *     RELAY_URL=http://localhost:8787 node scripts/smoke.mjs
 */
import {
  generateLinkCode,
  isValidLinkCode,
  deriveChannel,
  encryptEntry,
  decryptEntry,
  newDeviceId,
} from "../packages/protocol/src/crypto.ts";

let failures = 0;
const check = (name, condition) => {
  console.log(`${condition ? "  pass" : "  FAIL"}  ${name}`);
  if (!condition) failures++;
};
const rejects = async (name, fn) => {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
};

console.log("\ncrypto");

const code = generateLinkCode();
check("generated code is well formed", isValidLinkCode(code));
check("code carries 160 bits in 8 groups", code.split("-").length === 9);
check("free text is refused", !isValidLinkCode("AAAAAAAAAAAAAAAAAAAAAAAA"));
check("truncated code is refused", !isValidLinkCode(code.slice(0, 20)));

const channel = await deriveChannel(code);
const twin = await deriveChannel(code.toLowerCase().replace(/-/g, " "));
check("derivation is deterministic", channel.channelId === twin.channelId);
check("channel id and token are independent", channel.channelId !== channel.authToken);
check("channel id is 128 bits of base64url", channel.channelId.length === 22);

const other = await deriveChannel(generateLinkCode());
check("different codes give different channels", channel.channelId !== other.channelId);

const deviceA = newDeviceId();
const secret = "postgres://user:hunter2@10.0.0.4:5432/app";
const entry = await encryptEntry(secret, channel, deviceA);

check("plaintext is absent from the payload", !entry.ciphertext.includes("hunter2"));
check("origin device travels in the clear", entry.deviceId === deviceA);
check("round trip returns the original", (await decryptEntry(entry, channel)) === secret);

await rejects("a foreign channel cannot decrypt", () => decryptEntry(entry, other));
await rejects("a tampered device id fails the AAD check", () =>
  decryptEntry({ ...entry, deviceId: newDeviceId() }, channel));
await rejects("a rotated epoch cannot decrypt", () =>
  decryptEntry({ ...entry, epoch: 1 }, { ...channel, epoch: 1 }));
await rejects("flipped ciphertext fails the auth tag", () =>
  decryptEntry({ ...entry, ciphertext: "A" + entry.ciphertext.slice(1) }, channel));

const relay = process.env.RELAY_URL;
if (!relay) {
  console.log("\nrelay  skipped — set RELAY_URL to test the round trip");
} else {
  console.log(`\nrelay  ${relay}`);
  const base = relay.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${channel.authToken}`, "Content-Type": "application/json" };
  const url = `${base}/v1/channels/${channel.channelId}/entries`;

  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  check("health check responds", health.ok === true);

  const push = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify(entry) });
  check("entry accepted", push.status === 201);

  const fetched = await fetch(`${url}/latest`, { headers: auth }).then((r) => r.json());
  check("latest round trips", (await decryptEntry(fetched, channel)) === secret);

  const wrongToken = await fetch(`${url}/latest`, {
    headers: { Authorization: `Bearer ${other.authToken}` },
  });
  check("a foreign token is rejected", wrongToken.status === 401);

  const oversized = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...entry, ciphertext: "A".repeat(200_000) }),
  });
  check("oversized entry is rejected", oversized.status === 413);

  const malformed = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...entry, ciphertext: "not base64!!" }),
  });
  check("malformed payload is rejected", malformed.status === 400);

  await fetch(`${base}/v1/channels/${channel.channelId}`, { method: "DELETE", headers: auth });
  const afterWipe = await fetch(`${url}/latest`, { headers: auth });
  check("destroy empties the channel", afterWipe.status === 404);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
