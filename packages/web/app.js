/**
 * CopyMe web client.
 *
 * Polls the relay, decrypts locally, and never lets a link code or a plaintext
 * leave this file. The relay is only ever handed sealed payloads.
 */
import {
  generateLinkCode,
  isValidLinkCode,
  deriveChannel,
  encryptEntry,
  decryptEntry,
  newDeviceId,
} from "../protocol/src/crypto.js";

const POLL_MS = 2000;
const MAX_CHARS = 65000;
const KEY = { code: "copyme.code", device: "copyme.device", relay: "copyme.relay", auto: "copyme.autocopy" };

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ state */

const store = {
  get(k, fallback = null) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let channel = null;          // derived channel, held in memory
let deviceId = store.get(KEY.device);
let relayUrl = store.get(KEY.relay, "http://localhost:8787");
let autoCopy = store.get(KEY.auto) === "1";
let timer = null;
let firstLoad = true;
const seen = new Set();      // seq numbers already rendered

if (!deviceId) { deviceId = newDeviceId(); store.set(KEY.device, deviceId); }

/* ------------------------------------------------------------- chrome ops */

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1900);
}

function lamp(state, text) {
  $("lamp").dataset.state = state;
  $("lampText").textContent = text;
}

function fail(title, body) {
  $("bannerTitle").textContent = title;
  $("bannerBody").textContent = body ?? "";
  $("banner").hidden = false;
}
function clearFail() { $("banner").hidden = true; }

function show(screen) {
  clearFail();
  for (const id of ["setup", "handover", "station"]) $(id).hidden = id !== screen;
  $("openSettings").hidden = screen !== "station";
}

/* -------------------------------------------------------------- relay I/O */

function endpoint(path) {
  return `${relayUrl.replace(/\/+$/, "")}/v1/channels/${encodeURIComponent(channel.channelId)}${path}`;
}

async function call(path, options = {}) {
  const response = await fetch(endpoint(path), {
    ...options,
    cache: "no-store",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${channel.authToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Relay returned ${response.status}.`);
  return payload;
}

/* ---------------------------------------------------------------- sending */

async function send(text) {
  if (!text) return;
  if (text.length > MAX_CHARS) {
    fail("That's too long to send.", `The limit is ${MAX_CHARS.toLocaleString()} characters. Use git for anything larger.`);
    return;
  }
  $("sendBtn").disabled = true;
  try {
    const entry = await encryptEntry(text, channel, deviceId);
    await call("/entries", { method: "POST", body: JSON.stringify(entry) });
    $("draft").value = "";
    updateCount();
    clearFail();
    toast("Sent");
    poll();
  } catch (err) {
    fail("Couldn't send that.", err.message);
  } finally {
    $("sendBtn").disabled = !$("draft").value.trim();
  }
}

/* -------------------------------------------------------------- receiving */

async function poll() {
  if (!channel) return;
  try {
    const { entries = [] } = (await call("/entries")) ?? {};
    clearFail();
    lamp("live", "listening");

    // Server sends newest first; render oldest first so the stack reads right.
    for (const entry of [...entries].reverse()) {
      if (seen.has(entry.seq)) continue;
      seen.add(entry.seq);
      await render(entry, !firstLoad);
    }
    firstLoad = false;
    refreshFeedMeta();
  } catch (err) {
    lamp("error", "no relay");
    fail("Can't reach the relay.", `${err.message} Check the relay URL in Settings.`);
  }
}

async function render(entry, animate) {
  const mine = entry.deviceId === deviceId;
  let text;
  try {
    text = await decryptEntry(entry, channel);
  } catch {
    // A payload we cannot open is almost always a code mismatch between devices.
    text = null;
  }

  const li = document.createElement("li");
  li.className = `entry${mine ? "" : " remote"}${animate && !reducedMotion ? " arriving" : ""}`;

  const head = document.createElement("div");
  head.className = "entry-head";
  const origin = document.createElement("span");
  origin.className = "origin";
  origin.textContent = mine ? "this device" : `device ${entry.deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
  const time = document.createElement("time");
  time.textContent = new Date(entry.createdAt).toLocaleTimeString();
  head.append(origin, dot(), time);
  if (text !== null) { head.append(dot(), label(`${text.length} chars`)); }

  const body = document.createElement("div");
  body.className = "entry-body";

  const foot = document.createElement("div");
  foot.className = "entry-foot";

  if (text === null) {
    body.textContent = "Can't open this entry — it was sealed with a different link code.";
    body.style.color = "var(--alert)";
  } else {
    const copy = document.createElement("button");
    copy.className = "minibtn";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        copy.classList.add("done");
        setTimeout(() => { copy.textContent = "Copy"; copy.classList.remove("done"); }, 1400);
      } catch {
        fail("Your browser blocked the clipboard.", "Select the text and copy it manually.");
      }
    });
    const reuse = document.createElement("button");
    reuse.className = "minibtn";
    reuse.textContent = "Put in composer";
    reuse.addEventListener("click", () => {
      $("draft").value = text;
      updateCount();
      $("draft").focus();
    });
    foot.append(copy, reuse);
  }

  li.append(head, body, foot);
  $("feed").prepend(li);
  $("empty").hidden = true;

  if (text !== null) unseal(body, entry.ciphertext, text, animate && !mine);
  if (!mine && autoCopy && document.hasFocus() && text !== null) {
    navigator.clipboard.writeText(text).then(
      () => toast("Copied from your other device"),
      () => {},
    );
  }
}

const dot = () => Object.assign(document.createElement("i"), { className: "dot" });
const label = (t) => Object.assign(document.createElement("span"), { textContent: t });

/**
 * Shows the entry's real ciphertext for a beat, then resolves it into the
 * plaintext — which is exactly what just happened on this machine.
 */
function unseal(el, ciphertext, plaintext, animate) {
  if (!animate || reducedMotion || plaintext.length > 4000) {
    el.textContent = plaintext;
    return;
  }
  const steps = 8;
  let step = 0;
  el.classList.add("sealed");
  const tick = setInterval(() => {
    step++;
    if (step >= steps) {
      clearInterval(tick);
      el.classList.remove("sealed");
      el.textContent = plaintext;
      return;
    }
    const cut = Math.floor((plaintext.length * step) / steps);
    const tail = ciphertext.slice(cut, plaintext.length) || ciphertext.slice(0, plaintext.length - cut);
    el.textContent = plaintext.slice(0, cut) + tail;
  }, 38);
}

function refreshFeedMeta() {
  const n = $("feed").children.length;
  $("feedCount").textContent = n ? `${n} ${n === 1 ? "entry" : "entries"}` : "";
  $("empty").hidden = n > 0;
}

/* ------------------------------------------------------------- connecting */

async function connect(linkCode, { announce = false } = {}) {
  channel = await deriveChannel(linkCode);
  store.set(KEY.code, channel.linkCode);
  seen.clear();
  firstLoad = true;
  $("feed").replaceChildren();
  $("emptyHint").textContent = `this device is ${deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)} · relay ${relayUrl.replace(/^https?:\/\//, "")}`;
  show("station");
  lamp("idle", "connecting");
  clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
  await poll();
  if (announce) toast("Connected");
}

function disconnect() {
  clearInterval(timer);
  channel = null;
  store.del(KEY.code);
  seen.clear();
  $("feed").replaceChildren();
  lamp("idle", "offline");
  show("setup");
}

/* ----------------------------------------------------------------- wiring */

function updateCount() {
  const n = $("draft").value.length;
  const el = $("count");
  el.textContent = `${n.toLocaleString()} character${n === 1 ? "" : "s"}`;
  el.classList.toggle("over", n > MAX_CHARS);
  $("sendBtn").disabled = !$("draft").value.trim() || n > MAX_CHARS;
}

$("draft").addEventListener("input", updateCount);
$("draft").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send($("draft").value.trim()); }
});
$("sendBtn").addEventListener("click", () => send($("draft").value.trim()));

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast("Your clipboard is empty"); return; }
    $("draft").value = text;
    updateCount();
    $("draft").focus();
  } catch {
    fail("Your browser blocked reading the clipboard.", "Paste into the box instead — that always works.");
  }
});

let pendingCode = null;
$("createBtn").addEventListener("click", () => {
  pendingCode = generateLinkCode();
  $("codeText").textContent = pendingCode;
  show("handover");
});
$("copyCode").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(pendingCode); toast("Code copied"); }
  catch { toast("Select the code and copy it"); }
});
$("doneCode").addEventListener("click", () => connect(pendingCode, { announce: true }));

$("joinBtn").addEventListener("click", async () => {
  const code = $("joinInput").value.trim();
  if (!isValidLinkCode(code)) {
    fail("That code isn't valid.", "Codes look like CM- followed by eight groups of four. Only generated codes are accepted.");
    return;
  }
  clearFail();
  await connect(code, { announce: true });
});
$("joinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

$("relayInput").addEventListener("change", (e) => {
  relayUrl = e.target.value.trim() || relayUrl;
  store.set(KEY.relay, relayUrl);
});

$("testBtn").addEventListener("click", async () => {
  const base = ($("relayInput").value.trim() || relayUrl).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/healthz`, { cache: "no-store", credentials: "omit" });
    const body = await res.json();
    if (body.ok) { relayUrl = base; store.set(KEY.relay, base); clearFail(); toast("Relay is up"); }
    else fail("The relay answered, but not correctly.", `Status ${res.status}.`);
  } catch (err) {
    fail("Can't reach that relay.", `${err.message} Is it running, and does the URL include the scheme?`);
  }
});

$("bannerClose").addEventListener("click", clearFail);

$("openSettings").addEventListener("click", () => {
  $("relayInput2").value = relayUrl;
  $("autoCopy").checked = autoCopy;
  $("codeReveal").textContent = "••••••••••••••••";
  $("revealBtn").textContent = "Show";
  $("settings").showModal();
});
$("relayInput2").addEventListener("change", (e) => {
  relayUrl = e.target.value.trim() || relayUrl;
  store.set(KEY.relay, relayUrl);
  poll();
});
$("autoCopy").addEventListener("change", (e) => {
  autoCopy = e.target.checked;
  store.set(KEY.auto, autoCopy ? "1" : "0");
});
$("revealBtn").addEventListener("click", () => {
  const hidden = $("revealBtn").textContent === "Show";
  $("codeReveal").textContent = hidden ? channel.linkCode.replace(/^CM/, "CM-").replace(/(.{4})(?=.)/g, "$1-") : "••••••••••••••••";
  $("revealBtn").textContent = hidden ? "Hide" : "Show";
});
$("forgetBtn").addEventListener("click", () => { $("settings").close(); disconnect(); toast("This browser is disconnected"); });
$("eraseBtn").addEventListener("click", async () => {
  try {
    await call("", { method: "DELETE" });
    seen.clear();
    $("feed").replaceChildren();
    refreshFeedMeta();
    $("settings").close();
    toast("Channel erased");
  } catch (err) {
    fail("Couldn't erase the channel.", err.message);
  }
});

/* ------------------------------------------------------------------- boot */

$("relayInput").value = relayUrl;
updateCount();

const saved = store.get(KEY.code);
if (saved && isValidLinkCode(saved)) {
  connect(saved).catch(() => { disconnect(); fail("Couldn't restore your channel.", "Pair this browser again."); });
} else {
  show("setup");
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
