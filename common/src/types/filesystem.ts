import type fs from 'fs'

/** File system used for Codebuff SDK.
 *
 * Compatible with `fs.promises` from the `'fs'` module.
 */
export type CodebuffFileSystem = Pick<
  typeof fs.promises,
  | 'mkdir'
  | 'readdir'
  | 'readFile'
  | 'realpath'
  | 'stat'
  | 'unlink'
  | 'writeFile'
>
