/**
 * The Clipwire sidebar.
 *
 * The webview is presentation only: it never sees a channel id, never derives
 * a key, and never talks to the relay. It posts intents to the extension host,
 * which holds the secret and does the work. That keeps the crypto and the
 * SecretStorage access on one side of a boundary the webview cannot cross.
 */
import * as vscode from "vscode";

export interface PanelEntry {
  seq: number;
  mine: boolean;
  time: string;
  chars: number;
  text: string;
}

/** What the panel is allowed to ask the extension to do. */
export interface PanelApi {
  connect(channelId: string): Promise<void>;
  disconnect(): Promise<void>;
  send(text: string): Promise<void>;
  list(): Promise<PanelEntry[]>;
  clear(): Promise<void>;
  insert(text: string): Promise<void>;
  copy(text: string): Promise<void>;
  fingerprint(): string | null;
}

export class ClipwirePanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "clipwire.panel";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly api: PanelApi,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case "ready":
            await this.refresh();
            break;
          case "connect":
            await this.api.connect(msg.channelId);
            await this.refresh();
            break;
          case "disconnect":
            await this.api.disconnect();
            await this.refresh();
            break;
          case "send":
            await this.api.send(msg.text);
            await this.refresh();
            break;
          case "refresh":
            await this.refresh();
            break;
          case "clear":
            await this.api.clear();
            await this.refresh();
            break;
          case "insert":
            await this.api.insert(msg.text);
            break;
          case "copy":
            await this.api.copy(msg.text);
            this.post({ type: "toast", message: "Copied" });
            break;
        }
      } catch (err) {
        this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** Pulls fresh state and pushes it to the webview. */
  async refresh() {
    const fingerprint = this.api.fingerprint();
    if (!fingerprint) {
      this.post({ type: "state", connected: false });
      return;
    }
    this.post({ type: "state", connected: true, fingerprint });
    try {
      this.post({ type: "entries", entries: await this.api.list() });
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)],
    ).join("");

    // Colours come from the editor's own theme tokens, so the panel matches
    // whatever the user is running rather than imposing a palette.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  /* An author display rule beats the UA [hidden] rule, so .stack would keep
     flexing while hidden and show both panes at once. */
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .stack { display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; gap: 6px; }
  .row > * { flex: 1; }

  label {
    font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--vscode-descriptionForeground);
  }
  input, textarea {
    width: 100%; padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; font-family: var(--vscode-editor-font-family); font-size: 12px;
  }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  textarea { min-height: 72px; resize: vertical; line-height: 1.5; }

  button {
    padding: 6px 10px; cursor: pointer; border: none; border-radius: 2px;
    font-size: 12px; font-family: var(--vscode-font-family);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.quiet {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.quiet:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }

  .badge {
    display: flex; align-items: center; gap: 6px; justify-content: space-between;
    padding: 5px 8px; border-radius: 2px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-family: var(--vscode-editor-font-family); font-size: 11px;
  }
  .badge button { padding: 2px 7px; font-size: 10px; flex: 0 0 auto; }

  .error {
    padding: 6px 8px; border-radius: 2px; font-size: 11px; line-height: 1.45;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-foreground);
  }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }

  .entry {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-left: 2px solid var(--vscode-descriptionForeground);
    border-radius: 2px; padding: 7px 8px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .entry.theirs { border-left-color: var(--vscode-textLink-foreground); }
  .entry .meta {
    font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground);
  }
  .entry pre {
    margin: 0; font-family: var(--vscode-editor-font-family); font-size: 11.5px;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    max-height: 130px; overflow: auto;
  }
  .entry .row button { padding: 3px 8px; font-size: 10px; }
  .empty {
    text-align: center; padding: 18px 10px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 2px;
  }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); margin: 2px 0; }
</style>
</head>
<body>
<div class="stack">
  <div class="error" id="error" hidden></div>

  <div id="setup" class="stack" hidden>
    <label for="cid">Channel ID</label>
    <input id="cid" type="password" placeholder="shared secret" autocomplete="off" spellcheck="false">
    <button id="connect">Connect</button>
    <p class="hint">Use the same id on your other machine. It is also the password, so make it long.</p>
  </div>

  <div id="main" class="stack" hidden>
    <div class="badge">
      <span id="fp"></span>
      <button class="quiet" id="disconnect">Leave</button>
    </div>

    <label for="draft">Send</label>
    <textarea id="draft" placeholder="text to send" spellcheck="false"></textarea>
    <button id="send">Send</button>

    <hr>
    <div class="row">
      <button class="quiet" id="refresh">Refresh</button>
      <button class="quiet" id="clear">Clear</button>
    </div>
    <div class="stack" id="entries"></div>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const post = (msg) => vscode.postMessage(msg);

  const showError = (message) => { $("error").textContent = message; $("error").hidden = !message; };

  $("connect").addEventListener("click", () => {
    const channelId = $("cid").value;
    if (!channelId.trim()) return;
    showError("");
    post({ type: "connect", channelId });
    $("cid").value = "";
  });
  $("cid").addEventListener("keydown", (e) => { if (e.key === "Enter") $("connect").click(); });

  $("disconnect").addEventListener("click", () => post({ type: "disconnect" }));
  $("refresh").addEventListener("click", () => post({ type: "refresh" }));
  $("clear").addEventListener("click", () => post({ type: "clear" }));
  $("send").addEventListener("click", () => {
    const text = $("draft").value;
    if (!text.trim()) return;
    showError("");
    post({ type: "send", text });
    $("draft").value = "";
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      $("setup").hidden = msg.connected;
      $("main").hidden = !msg.connected;
      if (msg.connected) $("fp").textContent = msg.fingerprint;
      if (msg.connected) showError("");
    }
    if (msg.type === "error") showError(msg.message);
    if (msg.type === "entries") render(msg.entries);
  });

  function render(entries) {
    const host = $("entries");
    host.replaceChildren();
    if (!entries.length) {
      const box = document.createElement("div");
      box.className = "empty";
      box.textContent = "Nothing in this channel yet";
      host.append(box);
      return;
    }
    for (const entry of entries) {
      const el = document.createElement("div");
      el.className = "entry" + (entry.mine ? "" : " theirs");

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = (entry.mine ? "from here" : "from your other device") +
        "  ·  " + entry.time + "  ·  " + entry.chars + " chars";

      const body = document.createElement("pre");
      body.textContent = entry.text;

      const row = document.createElement("div");
      row.className = "row";
      const insert = document.createElement("button");
      insert.textContent = "Insert";
      insert.addEventListener("click", () => post({ type: "insert", text: entry.text }));
      const copy = document.createElement("button");
      copy.className = "quiet";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => post({ type: "copy", text: entry.text }));
      row.append(insert, copy);

      el.append(meta, body, row);
      host.append(el);
    }
  }

  post({ type: "ready" });
</script>
</body>
</html>`;
  }
}
