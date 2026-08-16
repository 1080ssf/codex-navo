# Codex Navo v1.2.96

## Direct Codex Desktop updates

- Codex Navo now checks Codex Desktop independently through the official OpenAI production update manifest. Codex does not need to be open and does not need to have been opened previously.
- When an official package is ready, Navo downloads and installs the MSIX directly without opening Microsoft Store.
- If Codex is running, Navo displays the installed and target versions and asks before closing it. Confirming closes only the Codex process family and continues the update; canceling leaves Codex untouched.
- The update card shows each phase: official version check, package propagation, Codex shutdown, download progress, package verification, installation, and installed-version verification.
- Before deployment, Navo validates HTTPS transport, package identity, OpenAI publisher, target version, and processor architecture. Windows App Deployment performs the final signature validation.

## Official update notes

- The Codex update card now includes recent entries from the [official OpenAI changelog](https://learn.chatgpt.com/docs/changelog).
- English Navo displays the official English text. Simplified Chinese Navo displays the corresponding Chinese translation while preserving official dates and entry structure.
- Changing the Navo interface language immediately changes the update-log language.
