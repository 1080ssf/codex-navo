# Codex Navo v1.2.103

## Account groups and SOCKS5 diagnostics

- Account category headers now use a clearer compact card style with separate accents for API Codex, temporary accounts, and regular accounts.
- Fixed SOCKS5 response buffering when authentication or CONNECT response bytes arrive in a single TCP packet.
- Node testing now performs the requested lightweight `https://chatgpt.com/` homepage check with a normal Chrome browser signature instead of calling a login-protected backend models endpoint.
- Transient TLS resets receive one retry. Persistent resets are labeled `TLS interrupted` so they are not confused with invalid proxy credentials.

The supplied SOCKS5 fixture was verified in layers: its format, credentials, SOCKS tunnel, TLS, and ChatGPT homepage request all succeeded after these detection fixes.
