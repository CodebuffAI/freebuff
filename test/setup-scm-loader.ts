// Required for cli unit tests: cli/bunfig.toml preloads this file, and
// without it `bun test` in cli/ fails on every file importing the
// @codebuff/sdk barrel, whose code-map imports *.scm query files bun has
// no loader for. Each file becomes a JS module default-exporting its text,
// which is how languages.ts consumes it.
Bun.plugin({
  name: 'setup-scm-loader',
  setup(build) {
    build.onLoad({ filter: /\.scm$/ }, async (args) => ({
      contents: `export default ${JSON.stringify(await Bun.file(args.path).text())}`,
      loader: 'js',
    }))
  },
})
