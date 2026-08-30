/**
 * Meow — an encrypted clipboard between your machines.
 *
 * Security posture, in one place so it can be checked:
 *
 *   - Built as a web extension. The host denies it filesystem, process and
 *     Node access outright, so the blast radius is a fetch to one origin.
 *   - The channel id is also the password. It is read with a masked prompt,
 *     stretched, and discarded; only the stretched secret reaches storage, and
 *     that storage is SecretStorage, backed by the OS keychain.
 *   - Nothing identifying the channel is written to settings, workspace state
 *     or the log. Channels are shown as a one-way fingerprint.
 *   - The relay must be https unless it is loopback, so a bearer token cannot
 *     cross the network in the clear.
 *   - Text is sealed before it leaves. The relay holds ciphertext it has no
 *     key for.
 *   - Sending is always an explicit command. The clipboard is never watched,
 *     which is the only way to be certain a password manager's contents are
 *     not swept up in passing.
 *   - No telemetry, no analytics, no third-party endpoint.
 */
import * as vscode from "vscode";
import {
  channelFromKey,
  channelFromStored,
  toStored,
  validateChannelKey,
  encryptEntry,
  decryptEntry,
  newDeviceId,
} from "../../protocol/src/crypto.js";
import { findSecrets } from "./secrets";

interface Channel {
  secret: string;
  channelId: string;
  authToken: string;
  fingerprint: string;
  epoch: number;
}

interface Entry {
  seq: number;
  v: number;
  epoch: number;
  deviceId: string;
  nonce: string;
  ciphertext: string;
  contentType: string;
  createdAt: number;
}

const SECRET_KEY = "meow.channel.v1";
const DEVICE_KEY = "meow.device.v1";
const REQUEST_TIMEOUT_MS = 30_000;

let channel: Channel | null = null;
let deviceId = "";
let status: vscode.StatusBarItem;

/* ------------------------------------------------------------------ relay */

/**
 * Plaintext http would put the channel's bearer token on the wire in the
 * clear, so it is refused outside loopback rather than merely discouraged.
 */
function relayUrl(): string {
  const raw = vscode.workspace
    .getConfiguration("meow")
    .get<string>("relayUrl", "https://copyme-relay.aravindbaranitharan.in")
    .trim()
    .replace(/\/+$/, "");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Relay URL is not a valid URL: ${raw}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Relay URL must use https. Plaintext http would expose your channel token.");
  }
  return raw;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  if (!channel) throw new Error('Not connected. Run "Meow: Connect to a Channel".');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${relayUrl()}/v1/channels/${encodeURIComponent(channel.channelId)}${path}`,
      {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error", // a redirect could carry the token to another origin
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${channel.authToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      },
    );
    if (response.status === 204) return null;
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Relay returned ${response.status}.`);
    return payload as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("The relay did not respond in time.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- session */

function paint() {
  if (!status) return;
  if (channel) {
    status.text = `$(clippy) Meow ${channel.fingerprint}`;
    status.tooltip = new vscode.MarkdownString(
      `Connected to channel \`${channel.fingerprint}\`.\n\n` +
        "This fingerprint is derived one way from your channel id. " +
        "It should read identically on your other machine.",
    );
    status.command = "meow.history";
  } else {
    status.text = "$(clippy) Meow";
    status.tooltip = "Not connected. Click to connect.";
    status.command = "meow.connect";
  }
  status.show();
}

async function requireChannel(): Promise<Channel> {
  if (!channel) throw new Error('Not connected. Run "Meow: Connect to a Channel".');
  return channel;
}

/* ------------------------------------------------------------- send guard */

/**
 * Confirms before sending anything that looks like a credential, or anything
 * unusually large. Returns false when the user backs out.
 */
async function confirmSend(text: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("meow");

  if (config.get<boolean>("warnOnSecrets", true)) {
    const hits = findSecrets(text);
    if (hits.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `This looks like it contains ${hits[0]}. Send it anyway?`,
        { modal: true, detail: "It will be encrypted before it leaves, but it will sit on the relay until the entry expires." },
        "Send anyway",
      );
      if (choice !== "Send anyway") return false;
    }
  }

  const threshold = config.get<number>("confirmLargeSends", 100_000);
  if (threshold > 0 && text.length > threshold) {
    const choice = await vscode.window.showWarningMessage(
      `Send ${text.length.toLocaleString()} characters?`,
      { modal: true },
      "Send",
    );
    if (choice !== "Send") return false;
  }
  return true;
}

async function send(text: string, what: string) {
  if (!text.trim()) {
    vscode.window.showWarningMessage(`Meow: no ${what} to send.`);
    return;
  }
  const active = await requireChannel();
  if (!(await confirmSend(text))) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Meow: sending…" },
    async () => {
      await call("/entries", {
        method: "POST",
        body: JSON.stringify(await encryptEntry(text, active, deviceId)),
      });
    },
  );
  vscode.window.setStatusBarMessage(`Meow: sent ${text.length.toLocaleString()} characters`, 2500);
}

/* ---------------------------------------------------------------- receive */

async function entries(): Promise<Entry[]> {
  const payload = await call<{ entries: Entry[] }>("/entries");
  return payload?.entries ?? [];
}

async function latestText(): Promise<string> {
  const active = await requireChannel();
  const all = await entries();
  if (all.length === 0) throw new Error("This channel is empty.");

  for (const entry of all) {
    try {
      return await decryptEntry(entry, active);
    } catch {
      continue; // sealed under a different id
    }
  }
  throw new Error("Nothing here opens with this channel id. Check both machines use the same one.");
}

async function insert(text: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage("Meow: no editor open — copied to the clipboard instead.");
    return;
  }
  await editor.edit((builder) => {
    if (editor.selection.isEmpty) builder.insert(editor.selection.active, text);
    else builder.replace(editor.selection, text);
  });
}

const preview = (text: string, max = 64) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/* ------------------------------------------------------------- activation */

function register(context: vscode.ExtensionContext, id: string, handler: () => Promise<void>) {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      try {
        await handler();
      } catch (err) {
        // Errors are surfaced, never logged — a message could carry a token.
        vscode.window.showErrorMessage(`Meow: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);

  deviceId = (await context.secrets.get(DEVICE_KEY)) ?? newDeviceId();
  await context.secrets.store(DEVICE_KEY, deviceId);

  const stored = await context.secrets.get(SECRET_KEY);
  if (stored) {
    try {
      channel = await channelFromStored(JSON.parse(stored));
    } catch {
      await context.secrets.delete(SECRET_KEY);
    }
  }
  paint();

  register(context, "meow.connect", async () => {
    const id = await vscode.window.showInputBox({
      title: "Meow: connect to a channel",
      prompt: "Enter the same channel id on both machines. It is also the password.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => validateChannelKey(value) ?? undefined,
    });
    if (!id) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Meow: deriving keys…" },
      async () => {
        channel = await channelFromKey(id);
        await context.secrets.store(SECRET_KEY, JSON.stringify(toStored(channel)));
      },
    );
    paint();
    vscode.window.showInformationMessage(
      `Meow: connected. Fingerprint ${channel!.fingerprint} — it should match your other machine.`,
    );
  });

  register(context, "meow.disconnect", async () => {
    await context.secrets.delete(SECRET_KEY);
    channel = null;
    paint();
    vscode.window.showInformationMessage("Meow: disconnected from this machine.");
  });

  register(context, "meow.showFingerprint", async () => {
    const active = await requireChannel();
    vscode.window.showInformationMessage(
      `Meow fingerprint: ${active.fingerprint}. Your other machine should show the same.`,
    );
  });

  register(context, "meow.sendSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage("Meow: select some text first.");
      return;
    }
    await send(editor.document.getText(editor.selection), "selection");
  });

  register(context, "meow.sendClipboard", async () => {
    await send(await vscode.env.clipboard.readText(), "clipboard text");
  });

  register(context, "meow.copyLatest", async () => {
    const text = await latestText();
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Meow: copied ${text.length.toLocaleString()} characters`, 2500);
  });

  register(context, "meow.insertLatest", async () => {
    await insert(await latestText());
  });

  register(context, "meow.history", async () => {
    const active = await requireChannel();
    const all = await entries();
    if (all.length === 0) {
      vscode.window.showInformationMessage("Meow: this channel is empty.");
      return;
    }

    const items: (vscode.QuickPickItem & { text: string })[] = [];
    for (const entry of all.slice(0, 30)) {
      try {
        const text = await decryptEntry(entry, active);
        items.push({
          label: preview(text),
          description: entry.deviceId === deviceId ? "from here" : "from your other device",
          detail: `${new Date(entry.createdAt).toLocaleTimeString()} · ${text.length.toLocaleString()} chars`,
          text,
        });
      } catch {
        continue;
      }
    }
    if (items.length === 0) {
      vscode.window.showWarningMessage("Meow: nothing here opens with this channel id.");
      return;
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Pick an entry" });
    if (!picked) return;

    const action = await vscode.window.showQuickPick(
      [
        { label: "Copy to clipboard", id: "copy" },
        { label: "Insert at cursor", id: "insert" },
      ],
      { placeHolder: "What would you like to do with it?" },
    );
    if (!action) return;

    if (action.id === "copy") {
      await vscode.env.clipboard.writeText(picked.text);
      vscode.window.setStatusBarMessage("Meow: copied", 2000);
    } else {
      await insert(picked.text);
    }
  });

  register(context, "meow.clearHistory", async () => {
    const active = await requireChannel();
    const choice = await vscode.window.showWarningMessage(
      `Erase every entry in channel ${active.fingerprint}?`,
      { modal: true, detail: "This clears it for every device on the channel and cannot be undone." },
      "Erase",
    );
    if (choice !== "Erase") return;
    await call("", { method: "DELETE" });
    vscode.window.showInformationMessage("Meow: channel history erased.");
  });

  register(context, "meow.setRelayUrl", async () => {
    const current = vscode.workspace.getConfiguration("meow").get<string>("relayUrl", "");
    const next = await vscode.window.showInputBox({
      title: "Meow: relay URL",
      value: current,
      ignoreFocusOut: true,
      prompt: "Must be https unless it is localhost.",
      validateInput: (value) => {
        try {
          const url = new URL(value.trim());
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (url.protocol !== "https:" && !loopback) return "Must use https outside localhost.";
          return undefined;
        } catch {
          return "That is not a valid URL.";
        }
      },
    });
    if (!next) return;
    await vscode.workspace
      .getConfiguration("meow")
      .update("relayUrl", next.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage("Meow: relay updated.");
  });

  register(context, "meow.testConnection", async () => {
    const base = relayUrl();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Meow: testing…" },
      async () => {
        const response = await fetch(`${base}/healthz`, { cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new Error(`Relay answered ${response.status}.`);
        const body = (await response.json()) as { ok?: boolean };
        if (!body.ok) throw new Error("Relay answered, but not correctly.");
      },
    );
    vscode.window.showInformationMessage(`Meow: relay is healthy at ${base}`);
  });
}

export function deactivate() {}
