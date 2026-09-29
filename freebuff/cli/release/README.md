# Freebuff

**The free coding agent.** No subscription. No configuration. Start in seconds.

An AI coding agent that runs in your terminal — describe what you want, and Freebuff edits your code.

## Install

```bash
npm install -g freebuff
```

## Usage

```bash
cd ~/my-project
freebuff
```

### Older Intel Macs (without AVX2)

The npm launcher automatically switches to the `darwin-x64-baseline` build if
the standard Intel binary exits with an illegal-instruction error (`SIGILL`).
To select that build before the first launch:

```bash
FREEBUFF_BINARY_TARGET=darwin-x64-baseline freebuff
```

For manual installation, download `freebuff-darwin-x64-baseline.tar.gz` from the
[Freebuff CLI releases](https://github.com/CodebuffAI/codebuff-community/releases?q=freebuff-v)
and keep the extracted `freebuff` binary and `tree-sitter.wasm` together.

## Why Freebuff?

**Choice of leading models** — The regular CLI picker includes GLM 5.3 Flash, DeepSeek, GPT-6 Luna, MiMo 2.6 Flash, MiMo 2.6 Pro, Solar Mini 4, Solar Pro 4, Space Bunny Alpha, Gemini 3.8 Flash, and Muse Spark 1.3, with GLM 5.3 Flash selected by default.

**Fast** — 5–10× speed up. 3–5× tokens per second compared to Claude, plus context gathering in seconds.

**Loaded** — Built-in web research, browser use, and more.

## FAQ

**How can it be free?** Freebuff is supported by text ads.

**What models do you use?** In full mode, the regular picker includes GLM 5.3 Flash, DeepSeek V4.1 Flash, GPT-6 Luna, MiMo 2.6 Flash, MiMo 2.6 Pro, Solar Mini 4, Solar Pro 4, Space Bunny Alpha, Gemini 3.8 Flash, and Muse Spark 1.3. Space Bunny Alpha is a beta stealth model from an anonymous provider that retains prompts. Gemini 3.8 Flash and Muse Spark 1.3 require a paid plan: without one they are listed but locked, and selecting one opens the plans page. GPT-6 Luna and MiMo 2.6 Pro are open to every full-access account. Muse Spark 1.3 has a 1M-token context and is rate limited across all users, so at busy times it queues and then answers on DeepSeek V4 Flash instead of leaving you waiting. GLM 5.3 Flash is the CLI default and the cheapest model to run. Limited mode uses GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo 2.6 Flash, Solar Mini 4, and Solar Pro 4. Every model is paid for in Freebucks, one price per one-hour session, shown in the model picker. Models may still serve from a quantized (Q8_0) build.

**Which countries is Freebuff available in?** All countries. Freebuff runs in "full" mode in the US, Canada, UK, EU, and other select countries, and in "limited" mode everywhere else (or while using a VPN). See [freebuff.com](https://freebuff.com) for the full list.

**What is limited mode?** Limited mode lets you use Freebuff outside the full-access countries, or while using a VPN. It includes GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo 2.6 Flash, Solar Mini 4, and Solar Pro 4. The free limited-access allowance is 25 Freebucks a day, or 20 on a VPN or proxy, and each model's price per one-hour session is shown in the picker. Today's allowance is spent first, whichever model you pick, including GLM 5.3 Flash; Freebucks you earn on the Earn page go into your wallet and are used once today's allowance runs out.

<!-- BEGIN GENERATED FREEBUFF DATA USE -->

**Is my data used to train AI?** Only when a model or feature says data may be used for AI training. Freebuff or the provider may then keep submissions to develop, train, test, evaluate, fine-tune, and improve AI models or products.

**How is my data used and stored?** We use prompts, messages, agent traces, code, files, and repository data to provide Freebuff. We may analyze prompts and messages to personalize ads. We do not give separately uploaded files or connected repositories to advertising providers. Restricted partners may evaluate connected Cloud repositories, but cannot otherwise use, broadly share, or train on them. See the Privacy Policy for retention, eligibility, and advertising choices.

See the [Privacy Policy](https://freebuff.com/privacy-policy) for complete details.

<!-- END GENERATED FREEBUFF DATA USE -->

## Links

- [Documentation](https://codebuff.com/docs)
- [GitHub](https://github.com/CodebuffAI/codebuff)
- [Website](https://codebuff.com)

> Built on the [Codebuff](https://codebuff.com) platform.
