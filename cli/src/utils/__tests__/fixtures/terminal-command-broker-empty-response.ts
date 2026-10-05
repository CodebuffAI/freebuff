import { closeSync, openSync } from 'fs'

import { protocolPathFromEnv } from '../../terminal-command-broker'

// What a broker leaves behind when its temp directory is full: `wx` creates
// the result file, then the write fails with ENOSPC before any byte lands.
closeSync(openSync(protocolPathFromEnv(), 'wx', 0o600))
process.exit(0)
