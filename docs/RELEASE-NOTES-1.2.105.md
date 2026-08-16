# Codex Navo v1.2.105

## All Codex task websites follow the selected route

- Codex task traffic now uses the selected route for arbitrary remote websites, not only OpenAI or GitHub.
- Both regular-account and API Codex launches cover Chromium plus proxy-aware native and child processes.
- Local Navo services remain direct and the Windows system proxy is untouched.
- The compact node workspace applies equally to standalone proxy nodes and airport subscription sources, eliminating the large blank area under short node lists.

## Cloudflare-protected routes no longer request an impossible verification

- API Key and account route dialogs now show `Reachable (CF protected)` instead of `Verification needed`.
- The route can be saved and used normally because SOCKS authentication, TLS, and ChatGPT reachability have already succeeded.
- Navo does not open a separate verification browser whose Cloudflare cookies could not be shared with Codex or an API Key.
- If a real account browser encounters a challenge later, that challenge remains within the account's isolated Chrome profile where it belongs.
- The complete network workspace now contracts to the visible node content. The left source list scrolls inside the same height, eliminating the remaining blank block beside a one-node source.

This supersedes the row-only spacing adjustment from v1.2.104, which did not constrain the outer two-column workspace.
