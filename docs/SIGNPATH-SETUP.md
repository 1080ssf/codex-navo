# SignPath Foundation setup

This document contains the project-side configuration required after SignPath Foundation approves the Codex Navo application.

## SignPath project values

Create these GitHub repository variables under **Settings > Secrets and variables > Actions > Variables**:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`

Create this GitHub Actions secret:

- `SIGNPATH_API_TOKEN`

The API token must belong to a SignPath user with submitter permission only. Signing approval should remain assigned to the separate approver role.

## Artifact configuration

Create an artifact configuration for the final NSIS installer using this XML. The workflow passes the package version as the `version` parameter.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <pe-file
    product-name="Codex Navo"
    product-version="${version}"
    file-version="${version}"
    company-name="1080ssf">
    <authenticode-sign />
  </pe-file>
</artifact-configuration>
```

The GitHub workflow uploads the installer without wrapping it in a ZIP archive, so the root artifact type is `pe-file`. Set the resulting artifact-configuration slug in the repository variable listed above.

## Signing policy

Use a manual-approval release policy connected to the `1080ssf/codex-navo` GitHub repository and the predefined `GitHub.com` trusted build system. Install the SignPath GitHub App with access to this repository. SignPath Foundation requires GitHub-hosted runners for all jobs leading to an OSS signing request.

## Release process

1. Push a version tag such as `v1.2.119`, or run **Build and sign Windows release** manually.
2. Wait for tests and the unsigned GitHub artifact build to complete.
3. Review and approve the signing request in SignPath.
4. Download the `codex-navo-signed-<version>` artifact from the completed GitHub Actions run.
5. Upload only the signed installer to the GitHub Release.

The workflow verifies that the returned installer has a valid Authenticode signature before publishing the signed workflow artifact.

## Application draft

- Project name: `Codex Navo`
- Repository URL: `https://github.com/1080ssf/codex-navo`
- Homepage URL: `https://github.com/1080ssf/codex-navo`
- Download URL: `https://github.com/1080ssf/codex-navo/releases`
- Privacy policy URL: `https://github.com/1080ssf/codex-navo/blob/main/PRIVACY.md`
- Tagline: `An open-source Windows workspace for managing and monitoring multiple Codex accounts.`
- Description: `Codex Navo is a Windows desktop workspace for isolated Codex account management, quota and token visibility, OpenAI-compatible account pooling and failover, per-account proxy routing, project and session management, notifications, and a floating task-status window.`
- Maintainer type: individual/open-source community
- Build system: GitHub Actions
- Discovery source: ChatGPT
- Reputation: `The public GitHub project has published 12 releases with 367 verifiable GitHub release-asset downloads as of 2026-08-17. The repository includes active development history, public issue tracking, and Telegram and QQ user communities.`

The reputation field must contain only verifiable current information. Suitable links include the public GitHub repository, releases, commit history, issues or discussions, and community links. Do not claim download or usage statistics that cannot be verified.
