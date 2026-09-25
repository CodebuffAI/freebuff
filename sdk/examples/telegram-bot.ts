import { CodebuffClient } from '@codebuff/sdk'

// Telegram bridge for the Codebuff/Freebuff agent (freebuff issue #1426).
//
// Runs a Telegram bot that forwards each message to an agent run and replies
// with the agent's text output. Sessions are kept per chat: a follow-up
// message continues the previous run unless you send /new.
//
// Self-hosted: you run it next to the codebase you want the agent to work on.
//
// Required env:
//   TELEGRAM_BOT_TOKEN - token from @BotFather
//   CODEBUFF_API_KEY   - key from https://www.codebuff.com/api-keys
// Optional env:
//   FREEBUFF_AGENT   - agent id to run (default 'codebuff/base'; any agent
//                      from the store works, e.g. a free agent id)
//   FREEBUFF_WORKDIR - directory the agent operates on (default process.cwd())
//
// Run: bun sdk/examples/telegram-bot.ts

const AGENT = process.env.FREEBUFF_AGENT ?? 'codebuff/base'
const CWD = process.env.FREEBUFF_WORKDIR ?? process.cwd()

type RunState = Awaited<ReturnType<CodebuffClient['run']>>

type TelegramUpdate = {
  update_id: number
  message?: {
    chat: { id: number; type: string }
    text?: string
  }
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

async function tg(method: string, body?: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  if (!json.ok) throw new TelegramApiError(`Telegram ${method} failed: ${json.description}`, res.status)
  return json.result
}

function sendMessage(chatId: number, text: string) {
  return tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4096) })
}

async function main().catch((error) => {
  console.error('Telegram bridge exited:', error)
  process.exitCode = 1
})
 {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN')
  if (!process.env.CODEBUFF_API_KEY) throw new Error('Set CODEBUFF_API_KEY')

  const client = new CodebuffClient({ apiKey: process.env.CODEBUFF_API_KEY, cwd: CWD })
  const previousRuns = new Map<number, RunState>()
  // One run at a time per chat; later messages queue behind the active run.
  const queues = new Map<number, Promise<void>>()
  let offset = 0

  console.log(`Telegram bridge listening (agent: ${AGENT}, cwd: ${CWD})`)

  let backoffMs = 1_000
  while (true) {
    let updates: TelegramUpdate[]
    try {
      updates = (await tg('getUpdates', { offset, timeout: 30 })) as TelegramUpdate[]
      backoffMs = 1_000
    } catch (error) {
      // Fatal: bad token (401) or another poller is already running (409).
      // Everything else (network blips, 429/5xx) is transient: back off and retry.
      if (error instanceof TelegramApiError && [401, 409].includes(error.statusCode)) {
        throw error
      }
      console.error(`getUpdates failed, retrying in ${backoffMs}ms:`, error)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 30_000)
      continue
    }
    for (const update of updates) {
      offset = update.update_id + 1
      const message = update.message
      const text = message?.text
      if (!message || !text) continue
      if (message.chat.type !== 'private') continue // DM-only for now
      const chatId = message.chat.id

      if (text === '/start') {
        await sendMessage(chatId, "Send me a task and I'll run it with the agent. Use /new to start a fresh session.")
        continue
      }
      if (text === '/new') {
        previousRuns.delete(chatId)
        await sendMessage(chatId, 'Started a new session.')
        continue
      }

      const previous = previousRuns.get(chatId)
      const runChat = async () => {
        try {
          const runState = await client.run({
            agent: AGENT,
            prompt: text,
            previousRun: previous,
            handleEvent: async (event) => {
              if (event.type === 'text') await sendMessage(chatId, event.text)
              if (event.type === 'error' && !event.source) {
                await sendMessage(chatId, `Error: ${event.message}`)
              }
            },
          })
          previousRuns.set(chatId, runState)
          if (runState.output.type === 'error') {
            await sendMessage(chatId, `Run failed: ${runState.output.message}`)
          }
        } catch (error) {
          await sendMessage(chatId, `Run failed: ${(error as Error).message}`)
        }
      }
      const tail = queues.get(chatId) ?? Promise.resolve()
      queues.set(chatId, tail.then(runChat, runChat))
    }
  }
}

main()
