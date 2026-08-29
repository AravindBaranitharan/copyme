# CopyMe

An end-to-end encrypted clipboard you host yourself.

Text copied on one machine becomes available on another. The relay that carries
it holds no key and can decrypt nothing — it stores opaque blobs against a
channel id and hands them back to whoever presents the right token.

This repository currently contains the **relay** and the **protocol**. Clients
come next.

```
packages/protocol   key derivation and encryption, zero dependencies
packages/relay      Cloudflare Worker + Durable Object
scripts/smoke.mjs   protocol and round-trip verification
```

## How it works

A link code is 160 random bits, shown as `CM-XXXX-…` in eight groups. HKDF-SHA256
derives three unrelated values from it:

| Derived      | Label                   | Used for                        |
|--------------|-------------------------|---------------------------------|
| Channel id   | `copyme/v1/channel-id`  | routing; the relay sees this    |
| Auth token   | `copyme/v1/auth-token`  | proving membership to the relay |
| Content key  | `copyme/v1/content-key` | AES-GCM-256; never transmitted  |

The link code itself never leaves the device. Content is sealed with AES-GCM
under a fresh 96-bit nonce, with `channel | epoch | deviceId` bound in as
additional authenticated data, so a captured payload cannot be replayed into
another channel or a rotated epoch.

## Deploy

```bash
npm install
cd packages/relay
npx wrangler login
npx wrangler deploy
```

Wrangler prints your URL. Verify it:

```bash
curl https://copyme-relay.<your-subdomain>.workers.dev/healthz
```

Then run the full round trip against it:

```bash
RELAY_URL=https://copyme-relay.<your-subdomain>.workers.dev npm run smoke
```

Durable Objects hibernate when idle, so a personal deployment costs nothing at
rest and stays inside the free plan.

## Configuration

Set in `wrangler.toml` under `[vars]`.

| Variable                  | Default | Notes                                          |
|---------------------------|---------|------------------------------------------------|
| `ENTRY_TTL_SECONDS`       | `3600`  | Entries are dropped past this age              |
| `MAX_ENTRIES_PER_CHANNEL` | `50`    | Oldest are pruned beyond the cap                |
| `MAX_ENTRY_BYTES`         | `98304` | ~96 KB ciphertext, roughly 70 KB of plain text |
| `MAX_WRITES_PER_MINUTE`   | `120`   | Per channel                                     |

**On the TTL.** Shorter is safer. Fifteen minutes (`900`) keeps almost nothing on
the server but makes history close to useless. An hour is the shipped compromise.
Anything measured in days means your clipboard lives on a server all day, which
is a real decision rather than a default to accept quietly.

## API

Every route except `/healthz` needs `Authorization: Bearer <authToken>`.

| Method | Path                                | Purpose                    |
|--------|-------------------------------------|----------------------------|
| GET    | `/healthz`                          | Liveness, no auth          |
| POST   | `/v1/channels/{id}/entries`         | Store an encrypted entry   |
| GET    | `/v1/channels/{id}/entries/latest`  | Most recent entry          |
| GET    | `/v1/channels/{id}/entries`         | Recent entries, newest first |
| DELETE | `/v1/channels/{id}`                 | Erase the channel entirely |

## Security properties

**What the relay can do.** See ciphertext, sizes, timing, IP addresses, and
channel ids. It cannot read content — it has no key material and imports no
crypto beyond hashing tokens.

**Token binding.** The first token to touch a channel claims it; later requests
must match. Only a SHA-256 digest is stored, compared in constant time. Because
the channel id and the token come from separate HKDF labels, learning an id does
not yield the token.

**Generated codes only.** `isValidLinkCode` refuses anything that is not a
well-formed generated code. There is no low-entropy input to stretch, which is
why no stretching is needed.

**What it does not protect against.** Someone with access to your unlocked
machine. Anyone who obtains your link code — which is why the TTL is short and
epochs exist. And it will faithfully sync a password you copied, because a
clipboard cannot tell a password from anything else.

## Running it inside a company network

If this is carrying employer or client code, host the relay inside
infrastructure your organisation already controls — an Azure Container App or
Function on the corporate tenant, on a corporate domain — rather than a personal
Cloudflare account. The protocol does not care where the relay runs; only the
base URL changes. That difference is what makes it an internal tool rather than
an unsanctioned egress path, and it is worth confirming with whoever owns your
security policy before it carries anything real.

Encryption is not a substitute for permission.

## Verify

```bash
npm run smoke          # protocol only
cd packages/relay && npm run typecheck
```

## Limits

Entries are capped near 96 KB, so this moves snippets, traces, tokens and single
files — not repositories. To move a whole tree, use `git`. To move a day's work
as text, `git format-patch origin/main --stdout` is usually a few tens of
kilobytes and fits in a single entry.

## License

MIT
