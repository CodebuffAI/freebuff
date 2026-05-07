// Tool handlers for the Codebuff SDK
import { changeFile } from './change-file'
import { codeSearch } from './code-search'
import { glob } from './glob'
import { listDirectory } from './list-directory'
import { readFile } from './read'
import { getFiles } from './read-files'
import { runFileChangeHooks } from './run-file-change-hooks'
import { runTerminalCommand } from './run-terminal-command'

// Export tools under Tools namespace
export const ToolHelpers = {
  runTerminalCommand,
  codeSearch,
  glob,
  listDirectory,
  readFile,
  getFiles,
  runFileChangeHooks,
  changeFile,
}
