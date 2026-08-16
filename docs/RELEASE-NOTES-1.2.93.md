# Codex Navo v1.2.93

## Fixed

- Current-task input, cache, and output in the floating window now represent consumption since the task started.
- Multi-call tasks no longer replace their totals with the latest model call, so cache values remain cumulative instead of jumping between values such as 7.9K and 94.5K.

## Verified

- Navo's overall cache rate uses the raw Codex usage definition: the sum of cached input tokens divided by the sum of input tokens.
- Gateway request totals were checked against the incremental `total_token_usage` values in Codex session events, with no duplicate accumulation found.
