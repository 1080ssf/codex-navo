# Codex Navo v1.2.101

## ChatGPT sign-in now continues to Codex authorization

- Fixed a case where ChatGPT Web was visibly signed in, but Navo did not continue to the official Codex OAuth page.
- Chrome can briefly replace its local debugging endpoint during sign-in. Navo now detects the account profile's new endpoint and resumes the same login flow.
- A short Chrome process transition is no longer reported as a closed login window.
- The account-local browser remains isolated, and the automatic transition is still restricted to official `chatgpt.com` and `auth.openai.com` HTTPS addresses.

This release keeps the single-sign-in sequence introduced in v1.2.100: sign in to ChatGPT Web once, then confirm the official Codex authorization in the same account-local Chrome session.
