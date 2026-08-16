# Codex Navo v1.2.94

## Fixed

- The API Codex gateway now preserves native Codex session and cache-routing headers when forwarding Responses requests to the ChatGPT Codex backend.
- Local API credentials and conflicting transport headers remain blocked by a strict allowlist.
- The existing native `prompt_cache_key` is preserved; no unsupported nested cache fields are injected.

## Verified

A real three-turn comparison using the same underlying account and GPT-5.6 Sol found that the previous API path returned 0% cache reads in every turn, while the normal account path progressed from 83.67% to 89.81% and 97.24%. This release addresses the request-header difference identified by that comparison.
