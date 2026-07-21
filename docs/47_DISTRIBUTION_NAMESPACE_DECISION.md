# Oculory v0.1 distribution namespace decision

## Status

This document records a release-candidate decision, not a publication. Oculory has not been published, tagged, or released by this work.

On 2026-07-22, the following read-only registry command was run:

```sh
npm view oculory version maintainers dist-tags --json
```

The registry returned `latest` version `0.0.10` and maintainer handle `danforder`. The unscoped `oculory` package is therefore controlled by another npm owner. This repository must not publish to or overwrite that namespace.

## Options

| Option | What changes | Main tradeoff |
| --- | --- | --- |
| Transfer the unscoped package | Obtain an explicit transfer from the current npm owner before any publication | Keeps `npm install -g oculory`, but depends on another owner and cannot be assumed |
| Publish under an owned scope | Publish a package such as `@<approved-scope>/oculory` after the project owner creates and controls the scope | Available without taking over another package, but installation uses the scoped name |
| Homebrew formula | Distribute a pinned release artifact through a controlled tap | Good macOS/Linux ergonomics, but requires a release artifact, checksum maintenance, and a tap |
| Curl installer | Install a pinned, checksummed artifact with a reviewed script | Broad reach, but expands the security and maintenance surface and is not justified for this candidate |

The installed command can remain `oculory` under every npm package-name option because `package.json` maps the binary name independently:

```json
{
  "bin": {
    "oculory": "./bin/oculory"
  }
}
```

## Recommendation

For the first public pre-release, use an npm scope controlled by the Oculory project owner. Keep the package source name unchanged during Phase 9, keep the installed binary `oculory`, and defer Homebrew until a signed, immutable release artifact exists. Do not ship a curl installer for v0.1.

Local tarball installation is sufficient for this release candidate:

```sh
npm pack
npm install -g ./oculory-0.1.0.tgz
```

## Exact owner decision required

Before publication, the repository owner must record exactly one of these decisions:

1. `TRANSFER`: provide evidence that the current npm owner transferred the unscoped `oculory` package to an account controlled by the Oculory project; or
2. `SCOPED`: name the exact npm scope controlled by the project and approve the final scoped package name.

Until one decision is recorded and independently verified, npm publication is blocked. This decision does not authorize publishing, creating a tag, or creating a release.
