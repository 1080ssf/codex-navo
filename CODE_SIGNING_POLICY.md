# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Codex Navo release installers are built from the public GitHub repository by GitHub Actions on GitHub-hosted Windows runners. The unsigned workflow artifact is submitted through SignPath's GitHub trusted-build integration. SignPath verifies the build origin, and an authorized project approver must manually approve every signing request.

## Roles

- Committer and reviewer: [1080ssf](https://github.com/1080ssf)
- Signing approver: [1080ssf](https://github.com/1080ssf)

Changes to source code, dependencies, build scripts, GitHub Actions workflows, and this policy are reviewed as security-sensitive release changes. Multi-factor authentication is required for the GitHub and SignPath accounts used to maintain or approve releases.

## Privacy

See the [Codex Navo privacy policy](PRIVACY.md).

## Verification

Published Windows installers can be verified with PowerShell:

```powershell
Get-AuthenticodeSignature -LiteralPath .\Codex-Navo-Setup-*-windows-x64.exe
```

Official signed releases must report a valid Authenticode signature issued to SignPath Foundation and must originate from the [Codex Navo releases page](https://github.com/1080ssf/codex-navo/releases).
