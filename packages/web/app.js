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
  $("status").hidden = !on;
}

/** "Connected" only ever means the relay answered us, never merely that a
 *  channel was derived — deriving one always succeeds, even offline. */
function setStatus(state) {
  $("status").dataset.state = state;
  $("statusText").textContent =
    state === "connected" ? `Connected · ${channel.label}`
    : state === "offline" ? "Offline"
    : "Checking…";
}

/** Cheapest call that proves both reachability and that our token is right. */
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
    if (await verify()) await refresh();
    else fail("Channel is ready, but the relay is not reachable right now.");
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
  $("history").replaceChildren();
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
    setStatus("connected");
    toast("Sent");
    await refresh();
  } catch (err) {
    setStatus("offline");
    fail(`Could not send. ${err.message}`);
  } finally {
    $("sendBtn").disabled = false;
  }
});

/* ---------------------------------------------------------------- history */

function timeOf(entry) {
  return entry.createdAt ? new Date(entry.createdAt).toLocaleTimeString() : "";
}

function renderEmpty(message) {
  const box = document.createElement("div");
  box.className = "empty";
  box.textContent = message;
  $("history").replaceChildren(box);
}

/** Renders newest first, marking which side each entry came from. */
async function render(entries) {
  if (!entries.length) {
    renderEmpty("Nothing in this channel yet.");
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
      entry.deviceId === deviceId ? "sent from here" : "from your other device",
      timeOf(entry),
      `${text.length.toLocaleString()} chars`,
    ].filter(Boolean).join("  ·  ");

    const body = document.createElement("pre");
    body.textContent = text;

    const copy = document.createElement("button");
    copy.className = "btn";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1300);
      } catch {
        fail("The browser blocked the clipboard — select the text and copy it.");
      }
    });

    item.append(meta, body, copy);
    nodes.push(item);
  }

  if (!nodes.length) {
    renderEmpty("There are entries here, but none open with this channel id.");
    return;
  }
  $("history").replaceChildren(...nodes);
}

async function refresh() {
  $("receiveBtn").disabled = true;
  try {
    const { entries = [] } = (await call("/entries")) ?? {};
    setStatus("connected");
    clearFail();
    await render(entries);
  } catch (err) {
    setStatus("offline");
    fail(`Could not refresh. ${err.message}`);
  } finally {
    $("receiveBtn").disabled = false;
  }
}

$("receiveBtn").addEventListener("click", refresh);

$("clearBtn").addEventListener("click", async () => {
  $("clearBtn").disabled = true;
  try {
    await call("", { method: "DELETE" });
    setStatus("connected");
    clearFail();
    renderEmpty("History cleared.");
    toast("History cleared");
  } catch (err) {
    setStatus("offline");
    fail(`Could not clear history. ${err.message}`);
  } finally {
    $("clearBtn").disabled = false;
  }
});

/* ------------------------------------------------------------------ boot */

const saved = store.get(KEY.channel);
if (saved) {
  channelFromStored(JSON.parse(saved))
    .then(async (c) => { channel = c; showStation(true); if (await verify()) refresh(); })
    .catch(() => store.del(KEY.channel));
}
