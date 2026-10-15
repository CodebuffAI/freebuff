# agent-voice

Hold a hotkey. Speak. The text lands in whatever you were typing — locally,
with no audio ever leaving the machine.

Built for people who dictate to coding agents: hold `Ctrl/Cmd+Shift+Space`,
say the sentence, release, and it is pasted into the terminal, editor or chat
box that had focus. Transcription runs on whisper.cpp inside the app, so it
works on a plane, on an offline machine, and with source code you cannot send
to anyone.

## What it does

- **Push to talk** — global hotkey (remappable) with an always-on-top overlay
  that shows the microphone level.
- **Local transcription** — whisper.cpp via `whisper-rs`. Models download once
  and live in the app-data directory.
- **Pastes into the right window** — focus is captured before recording starts
  and restored before the paste keystrokes.
- **Snippets and vocabulary** — say "new line", get a newline; teach it that
  your project is "Khan" not "can".
- **AI cleanup (Pro)** — per-app modes that tidy the raw transcript using your
  own API key or a local Ollama model.
- **Agents can ask you (Pro)** — an MCP server exposes `ask_user_by_voice`, so
  Claude Code or Cursor can put a question on your overlay and read your spoken
  answer back.

## Tiers

|                             | Free                       | Pro ($59 once)              |
| --------------------------- | -------------------------- | --------------------------- |
| Minutes per day             | 30, resets at UTC midnight | Unlimited                   |
| Models                      | Whisper base, small        | + large-v3-turbo            |
| Modes, snippets, vocabulary | Snippets and vocabulary    | All, incl. AI cleanup modes |
| `ask_user_by_voice` (MCP)   | —                          | Yes                         |

The free tier is not a trial: there is no expiry and no account.

## Install

```bash
bun install
bun run tauri dev      # development
bun run tauri build    # NSIS + MSI on Windows, DMG on macOS, AppImage/deb on Linux
```

On Windows the first build needs the [MSVC build tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022),
and `whisper-rs` compiles with CMake. `clang` must be on `LIBCLANG_PATH` for
bindgen on every platform.

## Using it

1. Launch the app and hold the hotkey (default `Ctrl/Cmd+Shift+Space`).
2. The overlay appears at the bottom of the screen; speak.
3. Release. The transcript is pasted into the app you were in.

Pick a model under **Settings → Model**. Whisper base is a ~140 MB download;
large-v3-turbo is ~1.6 GB and noticeably better at code and proper nouns.

## Settings worth knowing

- **Hotkey** — any accelerator the global-shortcut plugin accepts. The new
  combo is registered before the old one is dropped, so a bad combo never
  leaves you without a working hotkey.
- **Language** — leave on auto-detect unless you switch between languages often.
- **Snippets / vocabulary** — matched on whole words, case-insensitively for
  snippets. A trigger such as `c++` works too.

## MCP integration (Pro)

`agent-voice mcp` is a stdio MCP server that exposes one tool:

```
ask_user_by_voice({ prompt, timeout_ms? })
```

It talks to the running GUI over a loopback HTTP bridge (the port is published
in `bridge.json` next to the app data), so the app must be running. Point any
MCP client at the binary:

```jsonc
{
  "mcpServers": {
    "agent-voice": {
      "command": "/path/to/agent-voice",
      "args": ["mcp"],
    },
  },
}
```

Without a Pro license the server starts but advertises no tools, so a
misconfigured agent fails loudly instead of silently doing nothing.

## Privacy

Audio is captured only while the hotkey is held, written nowhere, and
transcribed in-process. The only network traffic the app generates is:

- downloading a model the first time you select it (from Hugging Face),
- `POST /activate` when you enter a license code,
- checking the update feed.

Telemetry is not collected.

## Development

```bash
bun run typecheck        # app + worker
bun test                 # frontend helpers + worker (57 tests)
bun run build            # frontend bundle
cd src-tauri && cargo test   # Rust unit tests
```

The license backend is a Cloudflare Worker in [`worker/`](worker/README.md);
the token format and key rotation are documented in
[`docs/entitlement.md`](docs/entitlement.md).

## License

Source under the repository license. Whisper models are downloaded from
Hugging Face under their own licenses (MIT for most, see the model cards).
