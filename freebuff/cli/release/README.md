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

**Choice of leading models** — The regular CLI picker includes DeepSeek V4.1 Flash Fast, DeepSeek V4.1 Flash, DeepSeek V4.1 Flash Slow, GPT-6 Luna, Muse Spark 1.3, Muse Ember, Claude Haiku 5.5 · 100k context, GPT-6.1 Terra, Solar Pro 4, Solar Mini 4, Beam 1.0, Nemotron 3.5 Lightning, and Glyph Cluster, with DeepSeek V4.1 Flash Fast selected by default at full access.

**Fast** — 5–10× speed up. 3–5× tokens per second compared to Claude, plus context gathering in seconds.

**Loaded** — Built-in web research, browser use, and more.

## FAQ

**How can it be free?** Freebuff is supported by text ads.

**What models do you use?** In full mode, the regular picker includes DeepSeek V4.1 Flash Fast, DeepSeek V4.1 Flash, DeepSeek V4.1 Flash Slow, GPT-6 Luna, Muse Spark 1.3, Muse Ember, Claude Haiku 5.5 · 100k context, GPT-6.1 Terra, Solar Pro 4, Solar Mini 4, Beam 1.0, Nemotron 3.5 Lightning, and Glyph Cluster. The three DeepSeek rows are one model at three speeds: Flash Fast at full speed, Flash at a steady speed, and Flash Slow streamed more slowly for the fewest hours. Muse Spark 1.3, Muse Ember, Claude Haiku 5.5 · 100k context, and GPT-6.1 Terra require a paid plan: without one they are listed but locked, and selecting one opens the plans page. GPT-6.1 Terra is two sessions a day on every plan. GPT-6 Luna is open at full access, and needs a paid plan on newer accounts. Muse Spark 1.3 has a 1M-token context, and when it is busy or unavailable it answers on DeepSeek instead of leaving you waiting. Beam 1.0, Nemotron 3.5 Lightning, and Glyph Cluster are free experimental models that use none of your hours. DeepSeek V4.1 Flash Fast is the CLI default at full access; at limited access it is DeepSeek V4.1 Flash Slow, or DeepSeek V4.1 Flash with a paid plan. Limited mode opens DeepSeek V4.1 Flash Fast, DeepSeek V4.1 Flash, DeepSeek V4.1 Flash Slow, Solar Pro 4, Solar Mini 4, Beam 1.0, Nemotron 3.5 Lightning, and Glyph Cluster without a plan; the models a paid plan unlocks there are listed too, locked until you have one. Every model is paid for in hours, one multiplier per one-hour session, shown in the model picker (run `/model`), which is where to check current prices: an hour of DeepSeek V4.1 Flash Slow uses one hour of balance, a 3x model uses three. Models may still serve from a quantized (Q8_0) build.

**Which countries is Freebuff available in?** All countries. Freebuff runs in "full" mode in the US, Canada, UK, EU, and other select countries, and in "limited" mode everywhere else (or while using a VPN). See [freebuff.com](https://freebuff.com) for the full list.

**What is limited mode?** Limited mode lets you use Freebuff outside the full-access countries, or while using a VPN. Without a plan it opens DeepSeek V4.1 Flash Fast, DeepSeek V4.1 Flash, DeepSeek V4.1 Flash Slow, Solar Pro 4, Solar Mini 4, Beam 1.0, Nemotron 3.5 Lightning, and Glyph Cluster. The free limited-access allowance is 5 hours a day, or 4 on a VPN or proxy, and each model's multiplier per one-hour session is shown in the picker. Today's allowance is spent first, whichever model you pick; hours you earn on the Earn page go into your wallet and are used once today's allowance runs out.

<!-- BEGIN GENERATED FREEBUFF DATA USE -->

**Is my data used to train AI?** Only when a model or feature says data may be used for AI training. Freebuff or the provider may then keep submissions to develop, train, test, evaluate, fine-tune, and improve AI models or products, and Freebuff may share or sell them to third parties. Separately, Freebuff may use your data to train the models that choose and measure ads.

**How is my data used and stored?** Freebuff uses your messages, agent traces, and files to run the service and respond to your requests. We may analyze this data, and how you use the app, to personalize ads and train ad models. We do not give separately uploaded files, project files, or connected repositories to advertising providers. Restricted partners may evaluate repositories you connect to Freebuff Cloud, but cannot otherwise use, broadly share, or train on them. See the Privacy Policy for details.

**Does Freebuff read files outside my project?** No, with a few exceptions, such as files an agent reads in the conversation, files you share, and settings like your agent instructions and skills. See the Privacy Policy for details.

See the [Privacy Policy](https://freebuff.com/privacy-policy) for complete details.

<!-- END GENERATED FREEBUFF DATA USE -->

## Links

- [Documentation](https://codebuff.com/docs)
- [GitHub](https://github.com/CodebuffAI/codebuff)
- [Website](https://codebuff.com)

> Built on the [Codebuff](https://codebuff.com) platform.
