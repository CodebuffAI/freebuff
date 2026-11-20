/**
 * Module to store parsed CLI args for use across the application.
 * This is populated once at startup in index.tsx before the app renders.
 */

import type { ParsedArgs } from '../cli-args'

let parsedArgs: ParsedArgs | null = null

export function setParsedArgs(args: ParsedArgs): void {
  parsedArgs = args
}

export function getParsedArgs(): ParsedArgs | null {
  return parsedArgs
}

export function getPermissionOptions(): {
  noShell: boolean
  askShell: boolean
  projectOnly: boolean
  readOnly: boolean
} {
  if (!parsedArgs) {
    return {
      noShell: false,
      askShell: false,
      projectOnly: false,
      readOnly: false,
    }
  }
  return {
    noShell: parsedArgs.noShell,
    askShell: parsedArgs.askShell,
    projectOnly: parsedArgs.projectOnly,
    readOnly: parsedArgs.readOnly,
  }
}