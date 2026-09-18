# Release launcher core

This directory is the canonical implementation of the npm launchers used by
Codebuff, Codecane, and Freebuff. Each product keeps a small `index.js` in its
release package that supplies product-specific configuration to
`createLauncher()`.

The npm packages must remain standalone, so their `prepack` scripts copy
`launcher.js` and `http.js` into the package directory. `postpack` removes those
generated, gitignored files again. No lifecycle scripts run when users install
or uninstall the packages.

## Download integrity

The launcher downloads a `.tar.gz` from
`https://codebuff.com/api/releases/download/<version>/<file>` (a 302 to the
GitHub release asset) and verifies its sha256 **before** extracting it. The
expected hashes never come from the download origin:

- For the wrapper's own version they are read from the package's own
  `package.json` field `binaryChecksums` (`{ "<target>": "<sha256 hex>" }`).
- For a self-update to `latest` (or any other version) they are read from the
  npm registry's version document, which carries the same field.

That makes the npm registry (TLS + the package manifest) the trust root and
leaves the download host, and every redirect hop, unable to substitute a binary.
Verification fails **closed**: a missing or malformed checksum aborts the
install, so `write-binary-checksums.js` runs in each release workflow's npm
publish job — after the binaries are built — to stamp one hash per target into
the package manifest, and its `verify` mode fails the release if any target is
uncovered. Wrappers published before this field existed ignore it, so old
installs keep working.

Transport rules, in `http.js` / `launcher.js`: the `NEXT_PUBLIC_CODEBUFF_APP_URL`
override is honoured only over `https:` (or `http:` on localhost), redirects
never downgrade `https:` to `http:`, and a redirect may only land on the
original host, `codebuff.com`, `freebuff.com`, `github.com` (with `www.`
variants) or `*.githubusercontent.com`. Extraction admits only the binary and
`tree-sitter.wasm` as root-level plain files.

When changing launcher behavior, edit this directory and test all package
assemblies with:

```bash
npm pack ./cli/release --dry-run
npm pack ./cli/release-staging --dry-run
npm pack ./freebuff/cli/release --dry-run
```
