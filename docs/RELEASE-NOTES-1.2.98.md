# Codex Navo v1.2.98

## Fully hidden Codex updates

- Fixed the PowerShell or Windows Terminal window that could appear while Navo checked or installed a Codex update.
- Codex update operations now run completely in the background. Progress, completion, and errors are shown only in the Navo update card.
- The hidden launcher retains access to the official Windows Store package update API without opening Microsoft Store.
- Update parameters are passed explicitly into the packaged Codex process, avoiding failures caused by Windows dropping custom environment variables at the package boundary.

## Notification replay fix

- Fixed historical completed turns being treated as newly completed work after a Codex session catalog rescan.
- Completion, failure, interruption, and waiting alerts now require a fresh timestamp; historical records remain visible in Session Management but do not trigger notifications.
- Notification polling now permits only one active request at a time, preventing the same queued event from being shown more than once by overlapping refreshes.
