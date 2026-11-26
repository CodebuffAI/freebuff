# Freebuff

English | [简体中文](./README.zh-CN.md)

**Five free AI products for coding, building, and research.** No subscription, credits, or API key required.

[Freebuff](https://freebuff.com) brings specialized agents and a choice of leading models to your terminal, desktop, browser, and GitHub repositories. Text ads support access to the included models.

## Choose your Freebuff

| Product              | What it does                        | Get started                                                           |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| **Freebuff Desktop** | Run parallel agents locally         | [Download for macOS, Windows, or Linux](https://freebuff.com) |
| **Freebuff CLI**     | Code from your terminal             | [Install the CLI](https://freebuff.com/cli)                           |
| **Freebuff Web**     | Build and ship full-stack apps      | [Build an app](https://freebuff.com/web)                              |
| **Freebuff Cloud**   | Run agents on any GitHub repository | [Connect a repository](https://freebuff.com/cloud)                    |
| **Freebuff Chat**    | Research and think with AI          | [Start a chat](https://freebuff.com/chat)                             |

The Freebuff apps for iOS and Android let you follow and continue your chats from your phone, including chats running on your computer while Freebuff Desktop is open: [get the mobile app](https://freebuff.com/mobile).

## Quick start

Run Freebuff in any project from your terminal:

```bash
npm install -g freebuff
cd ~/my-project
freebuff
```

Then describe what you want. Freebuff finds the relevant files, makes changes, and runs the checks that matter for your project.

## Models

Freebuff includes a curated model catalog. The regular picker currently offers:

| Model                       | Access                  | Best for                                                          |
| --------------------------- | ----------------------- | ----------------------------------------------------------------- |
| **DeepSeek V4.1 Flash**     | Full and limited access | Fast coding and tool use at a steady speed, 1M context; the default at limited access with a paid plan |
| **DeepSeek V4.1 Flash Slow** | Full and limited access | The same model streamed more slowly, for fewer hours; the default at limited access without a plan, and in Chat mode |
| **Solar Mini 4**            | Full and limited access | Upstage's fast, compact model; 500K context, text only |
| **Solar Pro 4**             | Full and limited access | Upstage's larger, stronger model; 500K context, text only |
| **Beam 1.0**, **Glyph Cluster** and **Nemotron 3.5 Lightning** | Full and limited access | Free experimental models that use none of your hours; 256K context |
| **DeepSeek V4.1 Flash Fast** | Full and limited access | The same DeepSeek model at full speed; the default at full access |
| **GPT-6 Luna**              | Full access; paid plans on newer accounts | Strong all-around with native images; 1M context |
| **Muse Spark 1.3**          | Paid plans              | Meta's agentic coding model; 1M context. When it is busy or unavailable, it answers on DeepSeek V4.1 Flash rather than making you wait |
| **Muse Ember**              | Paid plans              | Meta's fast coding model; 375K context |
| **Claude Haiku 5.5 · 100k context** | Paid plans      | Anthropic's fast model, with a 100K context window |
| **GPT-6.1 Terra**           | Paid plans              | OpenAI's model, two sessions a day; 1M context, images |

Prices change often, so this README does not list them: the model picker shows how many hours an hour on each model uses. An hour on a one-hour model uses one hour of your balance, an hour on a three-hour model uses three, and the free experimental models use none. Models may still serve from a quantized (Q8_0) build.

GLM 5.3 Flash, MiMo 2.6 Pro, GPT-6.1 Sol, Gemini 4 Argon and Gemini 3.8 Flash have been retired from the catalog, and MiMo v2.6 Flash Fast is no longer listed.

Beyond the regular picker:

- **Referrals and bounties** earn extra hours on top of the free daily allowance.
- **Gemini 3.1 Flash Lite** powers specialist tasks such as file finding and research rather than appearing in the main picker.

Availability and limits depend on your access tier, product, and current capacity. Freebuff Desktop can also run locally installed Claude Code and Codex agents using your existing provider account; those connected models are separate from Freebuff's included catalog.

## How Freebuff works

Freebuff uses specialized agents instead of sending every task through one model and one prompt. Depending on the task, agents gather context, plan, edit or research, run tools, and review the result.

- **Codebase context** — File-finding agents map the relevant parts of a project before editing.
- **Implementation and review** — Agents can divide work, make changes, run commands, and inspect the result.
- **Research and browser use** — Agents can investigate documentation and test applications in a real browser.
- **Parallel local work** — Desktop isolates concurrent agents in separate workspaces.
- **Hosted environments** — Web and Cloud provide sandboxes, previews, terminals, and deployment workflows.

## Free access

Freebuff is available in every country. Supported regions receive full access; other regions and VPN users receive limited access to DeepSeek V4.1 Flash, DeepSeek V4.1 Flash Slow, DeepSeek V4.1 Flash Fast, Solar Mini 4, Solar Pro 4 and the free experimental models (Beam 1.0, Glyph Cluster and Nemotron 3.5 Lightning), and a paid plan adds more. Every model is paid for in hours at the rate shown in the picker: an hour of DeepSeek V4.1 Flash Slow uses one hour of balance, a three-hour model uses three. The free limited-access allowance is 5 hours a day, or 4 on a VPN or proxy, spent first on every model; earned hours go into your wallet and are used after it. (Balances read in hours since 2026-10-15; 1 hour = 5 Freebucks.)

Text ads support the included models. Freebuff shows the applicable session limits and any model-specific data-use notice before you start.

<!-- BEGIN GENERATED FREEBUFF DATA USE -->

**Is my data used to train AI?** Only when a model or feature says data may be used for AI training. Freebuff or the provider may then keep submissions to develop, train, test, evaluate, fine-tune, and improve AI models or products, and Freebuff may share or sell them to third parties. Separately, Freebuff may use your data to train the models that choose and measure ads.

**How is my data used and stored?** Freebuff uses your messages, agent traces, and files to run the service and respond to your requests. We may analyze this data, and how you use the app, to personalize ads and train ad models. We do not give separately uploaded files, project files, or connected repositories to advertising providers. Restricted partners may evaluate repositories you connect to Freebuff Cloud, but cannot otherwise use, broadly share, or train on them. See the Privacy Policy for details.

**Does Freebuff read files outside my project?** No, with a few exceptions, such as files an agent reads in the conversation, files you share, and settings like your agent instructions and skills. See the Privacy Policy for details.

See the [Privacy Policy](https://freebuff.com/privacy-policy) for complete details.

<!-- END GENERATED FREEBUFF DATA USE -->

## Contributing

Freebuff is a TypeScript monorepo built with Bun. Contributions to the products, agents, tools, documentation, and underlying runtime are welcome.

Local development requires Docker and a configured `.env.local`; see the
[Contributing Guide](./CONTRIBUTING.md) before starting the services.

```bash
git clone https://github.com/CodebuffAI/freebuff.git
cd freebuff
bun install
bun up
```

Start the CLI separately with:

```bash
bun start-cli
```

See the [Contributing Guide](./CONTRIBUTING.md), [development guide](./docs/development.md), and [testing guide](./docs/testing.md) for environment setup and the checks to run before opening a pull request.

## Built on Codebuff

Freebuff is built on [Codebuff](https://codebuff.com), the open multi-agent framework that powers its orchestration, tools, and SDK. To create custom agents or embed them in another application, see the [Codebuff documentation](https://codebuff.com/docs) and [`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk).

## Links

- [Website](https://freebuff.com)
- [GitHub](https://github.com/CodebuffAI/freebuff)
- [Discord](https://discord.gg/yXG3w7wxfs)
- [Privacy Policy](https://freebuff.com/privacy-policy)
- [License](./LICENSE)
