# Codex Navo v1.2.109

## Complete language fallback coverage

- Audited the entire main interface, dynamic dialogs, status messages, confirmations, form hints, placeholders, tooltips, ARIA labels, and floating window.
- Added the missing English mappings for account management, authorization, API keys, proxy routes, session actions, wake tasks, and both Navo and Codex update flows.
- Dynamic `title`, `aria-label`, and `placeholder` changes are now translated after the initial page render.
- A new release-blocking audit verifies 651 Chinese UI strings and all 41 floating-window message keys.

## Locale behavior

- Simplified Chinese displays the complete Chinese Navo interface.
- Other Navo locale selections use the complete English fallback interface instead of leaving mixed Chinese details.
- Codex Desktop still receives the exact locale selected by the user, including Japanese, German, French, Traditional Chinese, and every other locale in the supported catalog.
