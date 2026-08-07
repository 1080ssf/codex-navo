# Security policy

Codex Navo handles local browser profiles and Codex authentication files. Treat every runtime profile as a credential container.

## Never include in a report

- `profiles/`
- `data/`
- `config/accounts.json`
- `config/settings.json`
- Browser cookies, `auth.json`, access tokens, refresh tokens, or screenshots containing account details

Redact account names, email addresses, Windows usernames, device codes, and absolute local paths before sharing logs or screenshots.

## Reporting a vulnerability

After this repository is published, use a private GitHub Security Advisory when possible. Include reproduction steps using test accounts and `mockLaunch`; do not open a public issue containing credentials or personal data.
