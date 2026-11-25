# Device-local secrets and local models

**An addition to [Freebuff](https://github.com/CodebuffAI/freebuff), built for Freebuff, by Freebuff, by [Lucas Owen](https://github.com/Quantico-code).**

This branch adds two things to Freebuff that the hosted product does not do on your own machine:

1. **Local models that can control your device.** Freebuff's agent loop, tools and permission prompts run against a model served by a runtime on this computer — Ollama, LM Studio, llama.cpp or vLLM — with no Freebuff server in the inference path.
2. **A device-local secret vault.** The model sees the *names* of your secrets and can use them, but never sees a value. Values are encrypted on disk, injected after the model has finished writing a command, and redacted from what comes back.

Both features live in the public CLI/SDK packages (`common/`, `cli/`, `sdk/`), which is the code Freebuff publishes in this repository. Nothing here touches a backend, and no value is ever sent to one.

---

## How this was built

This work was **built for Freebuff, by Freebuff**.

Lucas Owen set the direction — local models with real device control, and secrets the model can use but cannot read — and directed the work inside **Freebuff Desktop**. The implementation, tests and this document were written by Freebuff's own coding agent in this repository, with Lucas reviewing each step. Every commit on the branch is authored by Lucas Owen.

The result is an addition to Freebuff, made with Freebuff, in the same repository the Freebuff team publishes.

- **Branch:** `feat/secrets-and-local-models`
- **Commit:** `c1094974c` — *Add device-local secrets and local model discovery*

---

## Quick start

### Run the agent on a model on your machine

```bash
# In another terminal: start a runtime and pull a model
ollama serve
ollama pull qwen2.5-coder:7b
```

Inside Freebuff:

```text
/local                       # probe every known runtime on loopback
/local models ollama         # list the models Ollama is serving
/local use ollama qwen2.5-coder:7b
```

Freebuff saves an OpenAI-compatible BYOK connection pointed at `http://127.0.0.1:11434/v1`, selects it, and starts a fresh chat. From that point the same agent, the same tools and the same permission prompts run with the local model doing the reasoning. `/byok off` returns to the hosted models.

### Add a secret without putting it in the chat

```bash
# In the shell that launched Freebuff
export ACME_API_KEY="the-real-value"
```

Inside Freebuff:

```text
/secrets add ACME_API_KEY --from-env=ACME_API_KEY
/secrets list
```

Then ask for the thing that needs it:

> Use `$ACME_API_KEY` when you call the staging API.

The model writes a command containing `$ACME_API_KEY`. Freebuff adds the value to that one child process's environment, runs the command, and replaces every occurrence of the value in the output with `[secret:ACME_API_KEY]` before the model reads it.

---

## 1. Local models that can control your device

### What it does

`/local` probes the four runtimes people actually install, in parallel, with a 1.5-second timeout each:

| Runtime   | Endpoint                       |
| --------- | ------------------------------ |
| Ollama    | `http://127.0.0.1:11434/v1`    |
| LM Studio | `http://127.0.0.1:1234/v1`     |
| llama.cpp | `http://127.0.0.1:8080/v1`     |
| vLLM      | `http://127.0.0.1:8000/v1`     |

It reads each runtime's `/models` response and pulls out the model id, context window and on-disk size when the runtime reports them.

```text
● Ollama (http://127.0.0.1:11434/v1) — 3 models: `qwen2.5-coder:7b`, `llama3.1:8b`, `nomic-embed-text`
○ LM Studio (http://127.0.0.1:1234/v1) — not running
○ llama.cpp (http://127.0.0.1:8080/v1) — not running
○ vLLM (http://127.0.0.1:8000/v1) — not running
```

### Commands

| Command | What it does |
| ------- | ------------ |
| `/local` or `/local detect` | Probe all four runtimes on loopback |
| `/local models <runtime>` | List the models a runtime serves |
| `/local use <runtime> <model> [--context-window=N]` | Save and select a local BYOK connection |
| `/byok off` | Go back to the hosted models |

### "Control your device" is the existing agent, not a new one

A local model gets the same `run_terminal_command`, file editing, patching and search tools as a hosted model. It can inspect the project, change files, run tests and start processes — on this computer, under the same permission prompts, with the same workspace restrictions. That is the device control: the model thinks locally and the tools act locally.

What changes is the *quality* of the reasoning, not the reach of the tools.

### Loopback is enforced, not assumed

A connection labelled "local" must point at `localhost`, `127.0.0.1`, `::1` or a `*.localhost` name. `localByokInput()` throws on anything else, and discovery marks a non-loopback definition as refused instead of probing it. A remote provider cannot be dressed up as a local model through this path.

### Memory-fit guidance

`/local use` estimates whether the model fits, because the most common failure is loading a model larger than the machine:

- ~0.7 GB per billion parameters at 4-bit quantization
- ~60% of total RAM treated as usable
- `comfortable`, `tight`, `too-large`, or `unknown` when the id carries no parameter count

The estimate is guidance, not a benchmark, and the command says so. It does not prevent a run; it warns before one wastes ten minutes swapping.

### The honest disclaimer

The CLI prints this whenever a local model is selected, and it is part of the module's API on purpose:

> A local model runs on this machine, with no Freebuff server in the path. It will not match the hosted frontier models, especially on CPU-only hardware: expect slower turns and weaker tool use. The tools are the same, so it can still read, edit and run commands in this project.

There is no code change that makes a 7B model on a laptop reason like a hosted frontier model. What this integration does is make the *best model your hardware can run* a first-class Freebuff model, with real tools and real device control.

---

## 2. Device-local secrets

### The contract

- The model is shown a **name** — `ACME_API_KEY` — or the placeholder `${secret:ACME_API_KEY}`. It is never shown the value.
- Values are encrypted at rest with **AES-256-GCM**.
- Substitution happens **after** the model has finished writing: at the boundary where a command is spawned or a loopback request is made.
- Output is **redacted** before it goes back to the model.
- A reference is **refused** for a non-loopback destination.
- **Nothing expires.** A secret stays usable until it is rotated or removed.

### Commands

| Command | What it does |
| ------- | ------------ |
| `/secrets list` | Names, revisions and timestamps — never values |
| `/secrets add <NAME> --from-env=VARIABLE` | Store a new secret |
| `/secrets rotate <NAME> --from-env=VARIABLE` | Replace the value, bump the revision |
| `/secrets remove <NAME>` | Delete it permanently |

Values are **only** accepted from an environment variable. There is deliberately no way to type a value into the command: it would land in the chat transcript, the message history and possibly a log. Export it in the shell that launched Freebuff, then reference the variable with `--from-env=`.

Names are environment-variable shaped (`^[A-Z][A-Z0-9_]{1,63}$`). Values must be 8–4096 characters and contain no control characters; anything shorter cannot be redacted without eating ordinary words.

### Where the value lives

```text
~/.config/manicode/secrets/
├── secrets.vault.json   # AES-256-GCM ciphertext, 0600
└── secrets.key          # 32 random bytes, base64, 0600
```

- The vault directory is created `0700`.
- Each record has its own random 12-byte IV.
- The GCM additional authenticated data binds the ciphertext to `freebuff-secrets-v1`, the secret's **name** and its **revision** — so a record cannot be copied to another name, or rolled back to an older revision, without decryption failing.
- Writes go to a temporary file and are renamed into place; operations are serialized so concurrent writes cannot lose a record.
- A wrong key, a hand-edited file or a moved record produces `SecretDecryptError` with no detail from the ciphertext or key.

`FREEBUFF_CONFIG_DIR` moves the whole location, which is how tests isolate themselves.

### How a value is used

Two reference forms, both value-free:

| Form | Where it works | What happens |
| ---- | -------------- | ------------ |
| `$ACME_API_KEY` | `run_terminal_command` | The value is added to the child process's environment |
| `${secret:ACME_API_KEY}` | Headers, URL or body of a request to a loopback endpoint | The value is substituted at send time |

The command boundary is implemented in the SDK (`sdk/src/run.ts`) as `terminalSecretBoundary`, wired up by the CLI in `cli/src/utils/codebuff-client.ts`:

1. The model writes a command.
2. Only the secret names that actually appear in that command are looked up.
3. An existing environment variable with the same name is never overwritten — that is an error, not a silent replacement.
4. The command runs with those values in its environment.
5. Every string in the result — including JSON keys — is scanned for the plain value, its URL-encoded spelling and its base64 spellings, and replaced with `[secret:NAME]`.

`resolveForOutbound()` applies the same rule to HTTP: it checks the destination **before** reading any value. Loopback is always allowed; `allowHosts` exists for an operator who explicitly trusts another host, and cannot be reached from the model. A remote host is refused with an error that names the variables, never their values.

### No expiry, by design

Records carry `createdAt`, `updatedAt`, `lastUsedAt` and a revision, and nothing else. There is no TTL, no scheduled deletion and no "session" scope: a secret keeps working across restarts until you remove or rotate it. `/secrets remove` deletes the record outright.

---

## Architecture

| File | Role |
| ---- | ---- |
| `common/src/secrets.ts` | Vault, AES-256-GCM records, redaction, boundary injection and outbound resolution |
| `common/src/secrets.test.ts` | 17 tests |
| `common/src/local-models.ts` | Runtime definitions, loopback guarantee, discovery, model parsing, BYOK input, memory-fit estimate |
| `common/src/local-models.test.ts` | 9 tests |
| `cli/src/commands/secrets.ts` | `/secrets add \| list \| rotate \| remove` |
| `cli/src/commands/local.ts` | `/local`, `/local models`, `/local use` |
| `cli/src/utils/codebuff-client.ts` | Opens the vault and passes the terminal boundary into the SDK |
| `sdk/src/run.ts` | `TerminalSecretBoundary`, environment injection and deep output redaction at `run_terminal_command` |
| `cli/src/commands/command-registry.ts` | Routes the two slash commands |
| `cli/src/data/slash-commands.ts` | Help entries |

The flow for a secret used in a shell command:

```text
model writes:  curl -H "Authorization: Bearer $ACME_API_KEY" https://api.acme.test
                        │
                        ▼
       terminalSecretBoundary({ command, env })
                        │
      names = referencedSecretNames(command)
                        │
            vault.reveal("ACME_API_KEY")          ← decrypted here, not before
                        │
          child process environment + value
                        │
                        ▼
                command output
                        │
          redactSecretText(output, revealed)      ← "[secret:ACME_API_KEY]"
                        │
                        ▼
                 model reads output
```

The model's context never contains the value at any point in that sequence.

---

## Verification

Run from the repository root:

```bash
bun test common/src/secrets.test.ts common/src/local-models.test.ts
```

```text
26 pass
0 fail
76 expect() calls
Ran 26 tests across 2 files.
```

The suite covers, among other things:

- encryption round-trip and rotation
- decryption failure for a wrong key, a renamed record and a rolled-back revision
- refusal of invalid names, short values and duplicate names
- redaction of plain, URL-encoded and base64 spellings
- deep redaction of nested tool results, including keys
- injection only for referenced names, and refusal to overwrite an existing variable
- refusal of outbound substitution to a remote host before any value is read
- discovery of reachable and unreachable runtimes
- parsing of Ollama, LM Studio, llama.cpp and vLLM model shapes
- refusal to label a non-loopback endpoint as local
- memory-fit guidance

Type checks:

```bash
bun run --cwd=common typecheck
bun run --cwd=sdk typecheck
```

The CLI package has 13 pre-existing type errors in this snapshot (unrelated `tar` and `@types/react-dom` issues); none of them are in the files touched here.

### Not verified

- **A full TUI session with a live local model.** The commands, discovery, vault and boundary are unit-tested and type-checked; a run against a real Ollama instance was not part of this branch's verification.
- **The macOS/Windows installers.** This repository publishes the CLI and SDK, not the desktop shell, so these changes reach the CLI directly and the desktop app only when the Freebuff team ports them.

---

## What this does not do

These are limits of the repository and the design, not unfinished work.

- **iOS remote access.** The iOS app and its relay are closed source and are not in this repository. A local model can drive this computer through the CLI today; continuing that session from a phone needs the mobile app and backend, which cannot be added here.
- **A desktop secrets page.** The desktop UI is also not in the public source. The vault, encryption and boundary are shared code, so a UI can be built on them, but the page itself is not in this repo.
- **Server-side secret substitution.** Hosted and Cloud runs execute on Freebuff's servers. By design those servers never receive a value, so they cannot use these secrets. Substitution for them would require private backend code.
- **Model parity.** A local model's quality is bounded by the model and the hardware. The integration gives it the same tools, not the same weights.
- **A sandbox for hostile commands.** An injected value exists in the child process. Redaction protects against accidental echoes and logs; it cannot stop a command written specifically to exfiltrate its environment. Treat `run_terminal_command` approval the way you would treat running the command yourself.

---

## Credits

**Built for Freebuff, by Freebuff, by Lucas Owen.**

- Lucas Owen — direction, specification, review: [github.com/Quantico-code](https://github.com/Quantico-code)
- Freebuff — implementation, tests and documentation, written with Freebuff's own agent: [freebuff.com](https://freebuff.com)
- Freebuff source: [github.com/CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)
- This fork: [github.com/Quantico-code/freebuff](https://github.com/Quantico-code/freebuff)

Freebuff is built on [Codebuff](https://codebuff.com). Licensed under the repository's [LICENSE](./LICENSE).
