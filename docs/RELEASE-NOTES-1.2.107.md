# Codex Navo v1.2.107

## Natural-height network panels

- Network panels no longer depend on a JavaScript-calculated height, eliminating blank space caused by cached scripts, display scaling, or CSS row-size changes.
- The node pane now determines the panel height naturally. The source sidebar occupies the same boundary and scrolls independently when many sources are present.
- Historical 360-pixel and 280-pixel minimum heights were removed from the source container.
- The rendered single-node layout was measured directly: the node row and pane bottom edges match with `0 px` remaining blank space.

## Fast latency with reliable availability

- `Connection latency` measures how long the selected route takes to establish its proxy tunnel to `chatgpt.com:443`.
- The displayed millisecond value, node ordering, and automatic route selection all use this connection latency rather than the slower full-page response time.
- `ChatGPT check` retains the complete TLS and HTTP result only as a usability status, including unsupported regions, Cloudflare protection, and unstable exits.
- A low-latency route is therefore still prevented from being marked usable when ChatGPT actually blocks or rejects it.
