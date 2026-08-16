# Codex Navo v1.2.99

## Account web-session binding fix

- Codex OAuth success and ChatGPT Web login are now verified independently.
- Navo no longer marks account setup complete when ChatGPT returns HTTP 200 without an authenticated user, or when Chrome session inspection times out.
- After Codex OAuth completes, the same account-local Chrome remains in the web-login stage until a real ChatGPT user session is detected.
- Opening Web for an existing unbound account starts background verification. Once the user completes ChatGPT login in that Chrome profile, Navo saves the binding automatically.
- The OAuth flow opens only the official authorization page first, then moves to ChatGPT Web after Codex authorization succeeds, avoiding competing login tabs in the same profile.
