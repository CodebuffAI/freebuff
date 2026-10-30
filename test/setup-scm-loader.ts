import { plugin } from 'bun'
import { readFile } from 'fs/promises'

plugin({
  name: 'scm-text-loader',
  setup(build) {
    build.onLoad({ filter: /\.scm$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8')
      return {
        exports: { default: text },
        loader: 'object',
      }
    })
  },
})
