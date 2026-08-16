# Codex Navo v1.2.108

## Stable network source sidebar

- The desktop network source sidebar now keeps a fixed 352-pixel height.
- Multiple sources scroll inside the sidebar without being compressed by a short node list.
- Narrow layouts continue to use an automatic stacked height.

## Trustworthy connection latency

- A local Mihomo CONNECT acknowledgement is no longer treated as remote network latency.
- Timing now completes only after the real TLS handshake with `chatgpt.com`, eliminating misleading 1 ms results for remote exits.
- This verified handshake latency drives the displayed value, route ordering, and automatic route selection.
- The subsequent HTTP response remains a separate availability check for unsupported regions, Cloudflare protection, and connection failures.
