# Clipwire

Copy on one machine. Paste on the other.

Two computers that can't share a clipboard — your laptop and a remote VM, a work
machine and a personal one, a virtual desktop and the laptop in front of you.
Clipwire moves text between them without leaving the editor.

Everything is encrypted on your machine before it leaves. The server that
carries it can never read it.

## Getting started

**1. Install Clipwire on both machines.**

**2. On each one**, open the command palette (`Ctrl/Cmd+Shift+P`) and run
**Clipwire: Connect to a Channel**. Type the *same* channel id on both:

```
aravind-laptops-2026
```

That id is also the password — pick something only you would choose, and make
it long.

**3. Check the fingerprint** in the status bar. Both machines should show the
same eight characters. If they match, you're connected.

```
Clipwire 8qOWwOVc
```

## An example

You're debugging on a remote VM and need a command on your laptop.

**On the VM** — select the line, right-click, choose **Clipwire → Send Selection**:

```bash
kubectl -n payments logs deploy/ledger-api --since=15m | grep -i timeout
```

**On your laptop** — press `Ctrl/Cmd+Shift+P` and run
**Clipwire: Insert Latest at Cursor**.

The line appears where your cursor is. That's the whole thing.

You can send your clipboard instead of a selection, copy an arriving item
straight to the clipboard, or open **Clipwire: Show History** to pick from
recent items.

## Commands

| Command | What it does |
|---|---|
| Connect to a Channel | Pair this machine using a channel id |
| Send Selection | Send the selected text |
| Send Clipboard | Send whatever you last copied |
| Insert Latest at Cursor | Paste the newest item into the editor |
| Copy Latest to Clipboard | Put the newest item on your clipboard |
| Show History | Pick from recent items |
| Clear Channel History | Erase everything in the channel |
| Disconnect | Forget the channel on this machine |

## Is it safe

It's a tool that sends your clipboard off your machine, so the short answer
matters:

- **Encrypted before it leaves.** The server stores sealed text it has no key for.
- **Your id is never stored or shown.** It's stretched and kept in the OS keychain. The fingerprint you see is derived one way from it and gives nothing away.
- **The clipboard is never watched.** Sending is always a command you run. Nothing is picked up in the background.
- **It warns you.** If what you're sending looks like a password, key or token, it asks first.
- **No tracking.** No telemetry, no analytics, one server it talks to.
- **You can host the server yourself** — it's in the repo — and point Clipwire at it with **Set Relay URL**.

Source: [github.com/AravindBaranitharan/copyme](https://github.com/AravindBaranitharan/copyme)

## About

I'm **Aravind Baranitharan**, an AI engineer. I build systems.

[aravindbaranitharan.in](https://aravindbaranitharan.in)

## License

MIT
