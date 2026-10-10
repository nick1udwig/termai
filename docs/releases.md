# Building and publishing releases

The [Release workflow](../.github/workflows/release.yml) builds native Linux x86_64, Linux ARM64 and macOS Apple Silicon archives when a GitHub release is published.
Publishing a prerelease also triggers the workflow, while the installer selects stable releases by default.
All three native jobs must pass before the workflow uploads any release assets.

Each archive includes an official Node runtime, production npm dependencies built for that runtime, the frontend, server sources, launch and setup scripts, licenses and release metadata.
Linux archives additionally include a pinned Voxtype Mobile CPU daemon and its upstream installer.
Herdr is downloaded only if requested during installation and is checked against the binary checksum pinned in the bundle.

## Release procedure

1. Merge the release workflow and installer into the default branch before publishing the first release.
2. Update the version in `package.json` and `package-lock.json`, including the root package entry.
3. Commit the version change and push the commit you want to release.
4. Create a matching `vX.Y.Z` tag and publish a GitHub release for it.
5. Wait for the Release workflow to finish before distributing the install command.

The tag must exactly match `v` followed by the package version, including any prerelease suffix.
The workflow checks out the tag and records its commit in every archive.
The publication job uploads the three platform archives, individual `.sha256` files, `SHA256SUMS` and `install.sh` to that release.
Rerunning a failed workflow replaces assets for the same tag only after every target passes again.
The one-liner requires the first complete stable release to exist, so adding these files alone does not make its download URL live.

## Validate before publishing

Use **Actions → Release → Run workflow** to build without creating or modifying a release.
Select the workflow branch and optionally supply a branch, tag or commit in the `ref` field.
Manual runs produce downloadable workflow artifacts and never execute the publication job.

Every native build runs the type check, frontend build, unit suite and installer fixture suite.
The packaged smoke check starts the bundled server, pairs a browser client and exercises a real PTY with Bash prompt hooks.
The installation smoke check uses a disposable home directory, installs without external integrations, and starts the installed launcher outside the release directory.
These checks do not install Tailscale, download speech models or modify the runner's real user services.
Linux jobs also execute the bundled Voxtype binary and check that its linked runtime libraries are available.
Dictation setup and Tailscale login use isolated fixtures in the installer suite, so a real tailnet and model inference still need a separate acceptance check when companion pins change.

## Dependency pins

Edit [build/release-config.json](../build/release-config.json) to change Node, the Voxtype Mobile source commit or the Herdr release and per-platform SHA-256 checksums.
Use a full Voxtype Mobile parent commit so its recursive submodule pins select the matching daemon protocol.
CI builds its `parakeet` feature with CPU inference and includes the upstream `scripts/install-daemon`, license and source provenance.
Keep the daemon's model, Opus framing and capabilities protocol compatible with Termai's dictation client when updating that pin.
The speech model is downloaded by the upstream installer only when the user opts into dictation setup.
Rust uses the current stable toolchain with the pinned source's Cargo lockfile.

## Local packaging

Use the Node version from `build/release-config.json` and install the platform's native dependency build tools.
Linux builds require a checkout of the pinned Voxtype Mobile parent repository with initialized submodules and a built `artifacts/voxtype-mobile-daemon`.
Point `VOXTYPE_MOBILE_CHECKOUT` to that checkout before packaging a distributable release.

```sh
npm ci
npm run build
npm test
npm run test:install
VOXTYPE_MOBILE_CHECKOUT=/path/to/pinned/voxtype-mobile npm run release:package
node scripts/smoke-release.mjs release/termai-v0.1.0-linux-x64.tar.gz
node scripts/smoke-install.mjs release/termai-v0.1.0-linux-x64.tar.gz
```

Packaging requires a clean checkout, the pinned Node version and a complete Linux companion bundle.
For local development checks only, `TERMAI_RELEASE_ALLOW_DIRTY=1` permits a different Node version, an uncommitted checkout or a Linux archive without the companion daemon.
That override is never used by release CI.
Local smoke checks create temporary application data and do not restart an existing Termai server.
