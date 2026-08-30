/**
 * CopyMe web client.
 *
 * Enter a channel id, send text, refresh on the other machine. The id is also
 * the password: it never leaves this file, and the relay only ever holds sealed
 * payloads it cannot open.
 *
 * The lattice behind the panel is wired to real events — a send or an arrival
 * fires a shockwave — so the motion reports what the app is doing rather than
 * just filling space.
 */
import {
  channelFromKey,
  channelFromStored,
  toStored,
  validateChannelKey,
  encryptEntry,
  decryptEntry,
  newDeviceId,
} from "../protocol/src/crypto.js";
import { createLattice } from "./lattice.js";

const DEFAULT_RELAY = "http://localhost:8787"; // rewritten by build.mjs
const MAX_CHARS = 2_000_000;  // the relay caps ciphertext, which is ~4/3 of this
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

const lattice = createLattice($("lattice"));

/* ---------------------------------------------------------------- chrome */

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1700);
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
  $("status").hidden = !on;
}

/** "Connected" only ever means the relay answered — deriving a channel always
 *  succeeds, even offline, so the pill is set from a real request. */
function setStatus(state) {
  $("status").dataset.state = state;
  $("statusText").textContent =
    state === "connected" ? channel.fingerprint
    : state === "offline" ? "Offline"
    : "Checking";
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

async function verify() {
  setStatus("checking");
  try {
    await call("/entries");
    setStatus("connected");
    return true;
  } catch {
    setStatus("offline");
    return false;
  }
}

/* -------------------------------------------------------------- pairing */

async function open(buttonId) {
  const value = $("key").value;
  const problem = validateChannelKey(value);
  if (problem) { fail(problem); return; }

  const button = $(buttonId);
  const label = button.querySelector("span");
  const original = label.textContent;
  label.textContent = "Working";
  $("createBtn").disabled = $("joinBtn").disabled = true;

  try {
    await new Promise((r) => setTimeout(r, 16)); // let the label paint
    channel = await channelFromKey(value);
    store.set(KEY.channel, JSON.stringify(toStored(channel)));
    $("key").value = "";
    clearFail();
    showStation(true);
    lattice.shockwaveFrom(button, 1.4);
    if (await verify()) await refresh();
    else fail("Channel is ready, but the relay is not reachable right now.");
  } catch (err) {
    fail(err.message);
  } finally {
    label.textContent = original;
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
  $("history").replaceChildren();
  $("draft").value = "";
  clearFail();
  showStation(false);
});

/* ---------------------------------------------------------------- history */

function renderEmpty(message) {
  const box = document.createElement("div");
  box.className = "empty";
  box.textContent = message;
  $("history").replaceChildren(box);
}

/** Renders newest first, marking which side each entry came from. */
async function render(entries) {
  if (!entries.length) {
    renderEmpty("Nothing in this channel yet");
    return;
  }

  const nodes = [];
  for (const entry of entries) {
    let text;
    try {
      text = await decryptEntry(entry, channel);
    } catch {
      continue; // sealed under a different id; not ours to show
    }

    const item = document.createElement("div");
    item.className = `item${entry.deviceId === deviceId ? "" : " theirs"}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [
      entry.deviceId === deviceId ? "from here" : "from your other device",
      entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : "",
      `${text.length.toLocaleString()} chars`,
    ].filter(Boolean).join("  ·  ");

    const body = document.createElement("pre");
    body.textContent = text;

    const copy = document.createElement("button");
    copy.className = "btn";
    const copyLabel = document.createElement("span");
    copyLabel.textContent = "Copy";
    copy.append(copyLabel);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyLabel.textContent = "Copied";
        lattice.shockwaveFrom(copy, 0.7);
        setTimeout(() => { copyLabel.textContent = "Copy"; }, 1300);
      } catch {
        fail("The browser blocked the clipboard — select the text and copy it.");
      }
    });

    item.append(meta, body, copy);
    nodes.push(item);
  }

  if (!nodes.length) {
    renderEmpty("Entries here, but none open with this id");
    return;
  }
  $("history").replaceChildren(...nodes);
}

let lastSeen = 0;

async function refresh({ quiet = false } = {}) {
  $("receiveBtn").disabled = true;
  try {
    const { entries = [] } = (await call("/entries")) ?? {};
    setStatus("connected");
    clearFail();

    // A shockwave only when something genuinely new arrived from elsewhere.
    const newest = entries[0];
    if (!quiet && newest && newest.seq > lastSeen && newest.deviceId !== deviceId) {
      lattice.shockwaveFrom($("receiveBtn"), 1.3);
    }
    if (newest) lastSeen = Math.max(lastSeen, newest.seq);

    await render(entries);
  } catch (err) {
    setStatus("offline");
    fail(`Could not refresh. ${err.message}`);
  } finally {
    $("receiveBtn").disabled = false;
  }
}

$("receiveBtn").addEventListener("click", () => refresh());

/* ------------------------------------------------------------------ send */

$("sendBtn").addEventListener("click", async () => {
  const text = $("draft").value;
  if (!text.trim()) { fail("Nothing to send."); return; }
  if (text.length > MAX_CHARS) {
    fail(`Too long — the limit is ${MAX_CHARS.toLocaleString()} characters.`);
    return;
  }

  $("sendBtn").disabled = true;
  try {
    await call("/entries", {
      method: "POST",
      body: JSON.stringify(await encryptEntry(text, channel, deviceId)),
    });
    $("draft").value = "";
    clearFail();
    setStatus("connected");
    lattice.shockwaveFrom($("sendBtn"), 1.6);
    toast("Sent");
    await refresh({ quiet: true });
  } catch (err) {
    setStatus("offline");
    fail(`Could not send. ${err.message}`);
  } finally {
    $("sendBtn").disabled = false;
  }
});

$("clearBtn").addEventListener("click", async () => {
  $("clearBtn").disabled = true;
  try {
    await call("", { method: "DELETE" });
    setStatus("connected");
    clearFail();
    lastSeen = 0;
    renderEmpty("History cleared");
    toast("Cleared");
  } catch (err) {
    setStatus("offline");
    fail(`Could not clear history. ${err.message}`);
  } finally {
    $("clearBtn").disabled = false;
  }
});

/* ---------------------------------------------------------- lattice tools */

$("pulseBtn").addEventListener("click", () => {
  lattice.shockwave(innerWidth / 2, innerHeight / 2, 1.5, Math.max(innerWidth, innerHeight) * 0.85);
});

$("freezeBtn").addEventListener("click", () => {
  const next = !lattice.isRunning();
  lattice.setRunning(next);
  $("freezeLabel").textContent = next ? "Freeze" : "Run";
  $("freezeIcon").innerHTML = next
    ? '<path d="M7 4v16M17 4v16"/>'
    : '<path d="M6 4l14 8-14 8z"/>';
});

/* ------------------------------------------------------------------ boot */

const saved = store.get(KEY.channel);
if (saved) {
  channelFromStored(JSON.parse(saved))
    .then(async (c) => {
      channel = c;
      showStation(true);
      if (await verify()) refresh({ quiet: true });
    })
    .catch(() => store.del(KEY.channel));
}
