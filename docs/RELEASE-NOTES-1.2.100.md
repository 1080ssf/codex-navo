# Codex Navo v1.2.100

## One sign-in for ChatGPT Web and Codex

- New accounts now open ChatGPT Web first in their isolated Chrome profile.
- After Navo detects a real authenticated ChatGPT user session, the same tab automatically continues to OpenAI's official Codex OAuth page.
- Account credentials are entered once. The following Codex page may ask for authorization confirmation, but it does not require signing in to the account again.
- The Navo account card and setup dialog show the current phase: waiting for ChatGPT sign-in, then continuing Codex authorization.
- Navigation is restricted to official `chatgpt.com` and `auth.openai.com` HTTPS addresses.

This release also includes the strict web-session validation, existing-account repair, historical-notification replay fix, and hidden Codex updater from v1.2.99 and v1.2.98.
