# Codex Navo v1.2.104

## Cloudflare challenge classification and compact node rows

- HTTP 403 responses carrying `cf-mitigated: challenge` or a Cloudflare challenge page are now labeled `Verification needed`, not `Site rejected`.
- Challenge routes remain selectable so the isolated account Chrome can open and let the user complete the official browser verification.
- Unsupported countries and genuine non-challenge 403 responses remain blocked and clearly labeled.
- Node rows now use a compact 44-pixel height, removing the large empty area shown for a single SOCKS5 node.

The supplied SOCKS5 proxy was sampled six times: four responses were explicit Cloudflare challenges and two had transient TLS resets. Its proxy credentials and tunnel were valid; the route is challenged and somewhat unstable, not region-blocked.
