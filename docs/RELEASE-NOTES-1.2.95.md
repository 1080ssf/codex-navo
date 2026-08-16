# Codex Navo v1.2.95

## Codex Desktop update detection

- Navo now reads the version reported by Codex Desktop's own official Windows updater.
- A delayed `winget` / Microsoft Store index no longer causes a false "up to date" result.
- The update card shows the installed version and the newer official manifest version when they differ.
- If the package has reached `winget`, Navo keeps installing it in the background. If Codex has received the update earlier than `winget`, Navo reports that rollout state explicitly instead of claiming there is no update.

## Proxy checks

- Supported or unknown regions use one lightweight `chatgpt.com` reachability request.
- Displayed latency is the duration of that one request rather than the slowest result across four separate login and OAuth endpoints.
- Common unsupported regions identifiable from the node flag or name are labeled `ChatGPT 不支持` without spending time on a network probe.
- The static region rules follow OpenAI's official supported-country list; ambiguous node names still receive a real request instead of being guessed.
