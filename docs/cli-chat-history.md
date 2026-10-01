# Project chat history

The CLI keeps each project's saved chats under
`<config-dir>/projects/by-path/<project-key>/chats/`. The project key is the
SHA-256 hash of the full absolute project path, resolved with Node's
`path.resolve`. Different checkouts have separate histories even when their
folder names match. Selecting the same path again restores its history.

The production config directory defaults to `~/.config/manicode` on all
platforms. `FREEBUFF_CONFIG_DIR` overrides it with an absolute path;
development and test builds use `manicode-dev` and `manicode-test` respectively.

## Recovering history saved by older versions

Older versions stored chats under `<config-dir>/projects/<folder-name>/chats/`.
That directory could contain chats from several unrelated projects with the
same folder name. New versions leave those files untouched, but do not
automatically restore or migrate them: a saved chat does not reliably identify
which project owns it.

To recover a chat, close the CLI and inspect the old chat directory's
`chat-messages.json`. Only import a chat after confirming it belongs to the
project you want to continue. Keep the original directory as a backup.

Open a terminal in that project's root and run the following with Node. Replace
`CHAT_ID` with the name of the selected old chat directory. If using a
development build or a custom configuration, set `configDir` accordingly.

```js
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')

const configDir =
  process.env.FREEBUFF_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'manicode')
const root = path.resolve(process.cwd())
const chatId = 'CHAT_ID'
const key = createHash('sha256').update(root).digest('hex')
const source = path.join(
  configDir,
  'projects',
  path.basename(root),
  'chats',
  chatId,
)
const target = path.join(configDir, 'projects', 'by-path', key, 'chats', chatId)

fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
```

Restart the CLI in that project. The copied chat is now available in `/history`.
Copy individual verified chats rather than the whole legacy history directory.
