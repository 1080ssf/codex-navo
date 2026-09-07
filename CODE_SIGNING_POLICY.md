# Code signing policy

Codex Navo installers are currently unsigned. The project does not claim that current release artifacts carry an Authenticode signature.

Release installers are built from the public GitHub repository by GitHub Actions on GitHub-hosted Windows runners. The workflow runs the test suite, builds the Windows installer, records its SHA-256 checksum in the workflow summary, and uploads the resulting artifact. A future code-signing integration will only be enabled after the project has an approved signing provider and valid repository credentials.

## Roles

- Committer and reviewer: [1080ssf](https://github.com/1080ssf)
- Release approver: [1080ssf](https://github.com/1080ssf)

Changes to source code, dependencies, build scripts, GitHub Actions workflows, and this policy are reviewed as security-sensitive release changes. Multi-factor authentication is required for the GitHub account used to maintain releases.

## Privacy

See the [Codex Navo privacy policy](PRIVACY.md).

## Verification

Published Windows installers can be verified with PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\Codex-Navo-Setup-*-windows-x64.exe
```

Compare the result with the checksum recorded by the corresponding GitHub Actions build. Official releases must originate from the [Codex Navo releases page](https://github.com/1080ssf/codex-navo/releases).
