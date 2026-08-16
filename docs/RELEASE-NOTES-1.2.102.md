# Codex Navo v1.2.102

## Reuse the signed-in Chrome for Codex authorization

- Slow first-time account Chrome startup now has up to 30 seconds to expose its local control endpoint.
- If the account-local Chrome is already open and signed in to ChatGPT, clicking Continue Authorization reuses that browser instead of asking the user to close it.
- Navo requests a fresh official OAuth URL from the Codex login service on every authorization attempt.
- After the ChatGPT session is verified, the same account-local browser automatically opens the official Codex authorization page.
- During active sign-in, Navo watches only Chrome's local page address. Once the browser leaves the login route, it performs one real session confirmation and immediately opens OAuth. Session retries are throttled to avoid unnecessary authentication traffic. The 30-second startup allowance is only a maximum failure threshold.

The previous OAuth URL is intentionally not cached or reused because its state and login identifier belong to one authorization attempt.
