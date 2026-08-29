/**
 * CopyMe web client.
 *
 * Enter a channel id, send text, receive it on the other machine. The id is
 * also the password: it never leaves this file, and the relay only ever holds
 * sealed payloads it cannot open.
 */
import {
  channelFromKey,
  channelFromStored,
  validateChannelKey,
  encryptEntry,
  decryptEntry,
  newDeviceId,
} from "../protocol/src/crypto.js";

const DEFAULT_RELAY = "http://localhost:8787"; // rewritten by build.mjs
const MAX_CHARS = 65000;
const KEY = { channel: "copyme.channel", device: "copyme.device" };

const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let channel = null;
let deviceId = store.get(KEY.device);
if (!deviceId) { deviceId = newDeviceId(); store.set(KEY.device, deviceId); }

/* ---------------------------------------------------------------- chrome */

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

function fail(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}
function clearFail() { $("error").hidden = true; }

function showStation(on) {
  $("setup").hidden = on;
  $("station").hidden = !on;
  $("leaveBtn").hidden = !on;
  $("chip").hidden = !on;
  if (on) $("chip").textContent = channel.label;
}

/* -------------------------------------------------------------- relay io */

async function call(path, options = {}) {
  const response = await fetch(
    `${DEFAULT_RELAY.replace(/\/+$/, "")}/v1/channels/${encodeURIComponent(channel.channelId)}${path}`,
    {
      ...options,
      cache: "no-store",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${channel.authToken}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    },
  );
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Relay returned ${response.status}.`);
  return payload;
}

/* -------------------------------------------------------------- pairing */

async function open(buttonId) {
  const value = $("key").value;
  const problem = validateChannelKey(value);
  if (problem) { fail(problem); return; }

  const button = $(buttonId);
  const original = button.textContent;
  button.textContent = "Connecting…";
  $("createBtn").disabled = $("joinBtn").disabled = true;

  try {
    await new Promise((r) => setTimeout(r, 16)); // let the label paint
    channel = await channelFromKey(value);
    store.set(KEY.channel, JSON.stringify({
      secret: channel.secret, epoch: channel.epoch, label: channel.label,
    }));
    $("key").value = "";
    clearFail();
    showStation(true);
  } catch (err) {
    fail(err.message);
  } finally {
    button.textContent = original;
    $("createBtn").disabled = $("joinBtn").disabled = false;
  }
}

$("createBtn").addEventListener("click", () => open("createBtn"));
$("joinBtn").addEventListener("click", () => open("joinBtn"));
$("key").addEventListener("keydown", (e) => { if (e.key === "Enter") open("joinBtn"); });
$("key").addEventListener("input", clearFail);

$("leaveBtn").addEventListener("click", () => {
  store.del(KEY.channel);
  channel = null;
  $("out").hidden = true;
  $("draft").value = "";
  clearFail();
  showStation(false);
});

/* ------------------------------------------------------------ send / get */

$("sendBtn").addEventListener("click", async () => {
  const text = $("draft").value;
  if (!text.trim()) { fail("Nothing to send."); return; }
  if (text.length > MAX_CHARS) { fail(`Too long — the limit is ${MAX_CHARS.toLocaleString()} characters.`); return; }

  $("sendBtn").disabled = true;
  try {
    await call("/entries", {
      method: "POST",
      body: JSON.stringify(await encryptEntry(text, channel, deviceId)),
    });
    $("draft").value = "";
    clearFail();
    toast("Sent");
  } catch (err) {
    fail(`Could not send. ${err.message}`);
  } finally {
    $("sendBtn").disabled = false;
  }
});

let received = "";

$("receiveBtn").addEventListener("click", async () => {
  $("receiveBtn").disabled = true;
  try {
    const entry = await call("/entries/latest");
    received = await decryptEntry(entry, channel);
    $("outText").textContent = received;
    $("out").hidden = false;
    clearFail();
  } catch (err) {
    $("out").hidden = true;
    fail(/404|empty/i.test(err.message)
      ? "Nothing has been sent to this channel yet."
      : `Could not receive. ${err.message}`);
  } finally {
    $("receiveBtn").disabled = false;
  }
});

$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(received);
    toast("Copied");
  } catch {
    fail("The browser blocked the clipboard — select the text and copy it.");
  }
});

/* ------------------------------------------------------------------ boot */

const saved = store.get(KEY.channel);
if (saved) {
  channelFromStored(JSON.parse(saved))
    .then((c) => { channel = c; showStation(true); })
    .catch(() => store.del(KEY.channel));
}
