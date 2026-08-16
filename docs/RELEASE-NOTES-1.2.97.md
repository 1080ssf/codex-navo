# Codex Navo v1.2.97

## Codex update-channel fix

- Fixed the update card incorrectly stopping at “official package is still propagating” when Windows Store had already made the Codex update available.
- Navo now checks both official delivery paths in order:
  1. Windows Store silent package update API.
  2. OpenAI's official fallback MSIX CDN.
- The silent Store API runs under the installed Codex package identity, so it can download and install the update inside Navo without opening the Microsoft Store interface.
- If Codex is running, Navo still asks for confirmation before closing it. After installation, Navo verifies that the installed package reached the target version.
- “Still propagating” is shown only when the official manifest announces a version while neither official delivery path has the package ready.
