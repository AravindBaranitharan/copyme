# Meow

An encrypted clipboard between your machines, inside the editor.

Select code on one machine, send it, and paste it on the other. Text is sealed
on your device before it leaves. The relay carrying it holds ciphertext it has
no key for — and you can host that relay yourself.

## Getting started

1. Run **Meow: Connect to a Channel** and enter a channel id.
2. Do the same on your other machine, with the **same id**.
3. Check the fingerprint in the status bar matches on both. If it does, you are
   on the same channel.
4. Select text, right-click → **CopyMe → Send Selection**.
5. On the other machine, **CopyMe → Insert Latest at Cursor**.

The channel id is also the password. Anyone who knows it can read the channel,
so pick something only you would choose, and prefer something long.

## Commands

| Command | What it does |
|---|---|
| Connect to a Channel | Enter a channel id and pair this machine |
| Disconnect | Forget the channel on this machine only |
| Send Selection | Encrypt and send the editor selection |
| Send Clipboard | Encrypt and send the system clipboard |
| Copy Latest to Clipboard | Fetch and decrypt the newest entry |
| Insert Latest at Cursor | Fetch, decrypt and insert |
| Show History | Pick from recent entries |
| Clear Channel History | Erase the channel for every device on it |
| Show Channel Fingerprint | Display the fingerprint for comparison |
| Set Relay URL | Point at your own relay |
| Test Connection | Check the relay is reachable and healthy |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `meow.relayUrl` | the hosted relay | Where sealed text waits. Must be https outside localhost |
| `meow.warnOnSecrets` | `true` | Ask before sending anything shaped like a credential |
| `meow.confirmLargeSends` | `100000` | Ask before sending more than this many characters |

## How it is secured

**The id never lands anywhere.** It is read with a masked prompt, stretched with
PBKDF2-SHA256 at 2,000,000 iterations, and discarded. Only the stretched secret
is kept, in VS Code's `SecretStorage`, which is backed by the OS keychain — not
settings, not workspace state, not a file.

**Channels are shown as a fingerprint**, eight characters derived one way from
that secret. It is identical on every device in the channel and reveals nothing
about the id, so matching fingerprints confirm you are paired without either
screen displaying the secret.

**The relay cannot read anything.** Text is sealed with AES-GCM-256 under a
fresh nonce, binding channel, epoch and origin device as additional
authenticated data so a captured payload cannot be replayed elsewhere.

**Plaintext http is refused** outside loopback, so a channel token cannot cross
the network in the clear. Redirects are refused too, since one could carry the
token to another origin.

**Sending is always an explicit command.** The clipboard is never watched in the
background. That is deliberate: a watcher cannot tell a password manager's
contents from anything else, and this extension has no API that would let it
find out.

**Before sending, it looks.** Text shaped like a private key, cloud access key,
token, connection string or `.env` assignment prompts for confirmation. That is
a speed bump built on heuristics, not a guarantee — it will miss things.

**No telemetry, no analytics, no third-party endpoint.** The bundle contains one
outbound origin: the relay you configured.

**It is a web extension**, so the host denies it filesystem and process access
outright, and the same build runs in VS Code, Cursor and `vscode.dev`.

## What it does not protect against

Someone at your unlocked machine. Anyone who learns your channel id. And a
short, guessable id — stretching raises the cost of each guess but cannot
rescue `1234`. Entries also sit on the relay until they expire.

## Self-hosting

The relay is a small Cloudflare Worker in the same repository. Deploy your own
and point `meow.relayUrl` at it.

Source: https://github.com/AravindBaranitharan/copyme

## License

MIT
