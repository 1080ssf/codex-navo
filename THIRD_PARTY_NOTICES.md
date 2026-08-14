# Third-party notices

## Kenney Interface Sounds

Selected notification sound effects are from [Kenney Interface Sounds](https://github.com/Calinou/kenney-interface-sounds), created by Kenney and dedicated to the public domain under Creative Commons Zero (CC0 1.0). The source license is included with the packaged audio files.

## toSub2 protocol login

The experimental protocol-login component includes adapted, vendored source from
[`poxiao33/toSub2`](https://github.com/poxiao33/toSub2), licensed under the MIT License.

- Vendored files: `vendor/tosub2/protocol-login.mjs`, `vendor/tosub2/sentinel.mjs`, `vendor/tosub2/sentinel-sdk.js`
- Upstream license: `vendor/tosub2/LICENSE`
- Upstream project: https://github.com/poxiao33/toSub2

Codex Navo keeps its existing official browser OAuth as the default. The vendored
component is exposed only as an optional experimental interactive login method.

## Mihomo network core

The account-level proxy feature bundles an unmodified official Mihomo Windows
release as an installer resource. Codex Navo verifies its SHA-256 digest before
placing it in the local runtime directory. Mihomo is updated by changing the
pinned, verified version in a subsequent Codex Navo application release.

- Upstream project: https://github.com/MetaCubeX/mihomo
- Release source: https://github.com/MetaCubeX/mihomo/releases
- Upstream license: GNU General Public License v3.0
