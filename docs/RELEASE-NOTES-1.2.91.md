# Codex Navo v1.2.91

## Fixed

- API Codex daily usage no longer assigns the complete historical lifetime total to the current local day during migration.
- Today, Yesterday, 7-day, and 30-day API cards now read only real daily buckets. An empty day displays zero instead of falling back to lifetime usage.
- Lifetime API Key usage remains intact for request limits, Token limits, and the All records view.

Existing daily buckets created by v1.2.90 are reset once because they contain synthetic lifetime totals. Usage recorded after upgrading to v1.2.91 is tracked from that point forward in the correct local-day bucket.
