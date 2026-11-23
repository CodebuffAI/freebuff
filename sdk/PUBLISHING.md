# Publishing the Codebuff SDK

## Quick Start

To publish the SDK to npm:

```bash
# Publish to npm
bun run release
```

## What the Publishing Script Does

1. **Builds** the SDK with verification (includes smoke tests)
2. **Verifies** package contents with `npm pack --dry-run`
3. **Publishes** to npm (if not dry run)

## Build Process

The SDK now uses Bun's bundler to create dual ESM/CJS outputs:

1. **Dynamic externals** - Reads dependencies from package.json automatically
2. **Bundles ESM** format with external dependencies marked
3. **Bundles CJS** format with external dependencies marked
4. **Generates TypeScript declarations** using `tsc`
5. **Copies tree-sitter query files** using Bun's file APIs
6. **Runs smoke tests** to verify both ESM and CJS builds work

This replaces the previous `tsup` + manual package.json manipulation approach.

## Available Scripts

- `bun run build` - Build TypeScript only
- `bun run verify` - Build + run smoke tests
- `bun run smoke-test:dist` - Run smoke tests on existing build
- `bun run clean` - Remove dist directory
- `bun run release` - Remote build + publish to npm
- `bun run typecheck` - Type checking only

## Before Publishing

1. Update version in `package.json`
2. Update `CHANGELOG.md` with new changes
3. Run `bun run release` to publish

## Package Contents

The published package includes:

- All compiled `.js` files
- All TypeScript declaration `.d.ts` files
- Source maps `.d.ts.map` files
- README.md
- CHANGELOG.md
- Modified package.json with correct paths
