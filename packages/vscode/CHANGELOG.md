# Changelog

## 0.2.1

- The panel showed the connect form and the connected view at the same time.

## 0.2.0

- A Clipwire panel in the Activity Bar: connect, send, and browse what has
  arrived without touching the command palette. Every item shows which machine
  it came from, with Insert and Copy.
- The commands still work, and still take keybindings.

## 0.1.5

- Wording.

## 0.1.4

- Drop the banner from the marketplace page. The text says it already.

## 0.1.3

- Plainer description, and a README that shows a real example rather than
  describing one.

## 0.1.2

- New icon and a banner on the marketplace page.

## 0.1.1

- First release published from CI rather than uploaded by hand. No change to
  the extension itself: the pipeline verifies, refuses to publish when the tag
  disagrees with the manifest, re-runs the bundle audit, and ships to both the
  Marketplace and Open VSX.

## 0.1.0

- Connect to a channel with a single id, stretched with PBKDF2 and stored in the OS keychain
- Send the editor selection or the clipboard; copy or insert the latest entry
- History picker, and clearing a channel for every device on it
- Channel fingerprints so two machines can confirm pairing without showing the id
- Confirmation before sending anything shaped like a credential
- Relay URL is configurable and must be https outside localhost
