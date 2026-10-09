# The most powerful coding agent

Codebuff is a CLI tool that writes code for you.

1. Run `codebuff` from your project directory
2. Tell it what to do
3. It will read and write to files and run commands to produce the code you want

Note: Codebuff will run commands in your terminal as it deems necessary to fulfill your request.

## Installation

To install Codebuff, run:

```bash
npm install -g codebuff
```

(Use `sudo` if you get a permission error.)

## Usage

After installation, you can start Codebuff by running:

```bash
codebuff [project-directory]
```

If no project directory is specified, Codebuff will use the current directory.

Once running, simply chat with Codebuff to say what coding task you want done.

## Features

- Understands your whole codebase
- Creates and edits multiple files based on your request
- Can run your tests or type checker or linter; can install packages
- It's powerful: ask Codebuff to keep working until it reaches a condition and it will.

Our users regularly use Codebuff to implement new features, write unit tests, refactor code,write scripts, or give advice.

## Knowledge Files

To unlock the full benefits of modern LLMs, we recommend storing knowledge alongside your code. Add a `knowledge.md` file anywhere in your project to provide helpful context, guidance, and tips for the LLM as it performs tasks for you.

Codebuff can fluently read and write files, so it will add knowledge as it goes. You don't need to write knowledge manually!

Some have said every change should be paired with a unit test. In 2024, every change should come with a knowledge update!

## Tips

1. Type '/help' or just '/' to see available commands.
2. Create a `knowledge.md` file and collect specific points of advice. The assistant will use this knowledge to improve its responses.
3. Type `undo` or `redo` to revert or reapply file changes from the conversation.
4. Press `Esc` or `Ctrl+C` while Codebuff is generating a response to stop it.

## Troubleshooting

### Permission Errors

If you are getting permission errors during installation, try using sudo:

```
sudo npm install -g codebuff
```

If you still have errors, it's a good idea to [reinstall Node](https://nodejs.org/en/download).

### Corporate Proxy / Firewall

If you see `Failed to download codebuff: Request timeout` or `Failed to determine latest version`, you may be behind a corporate proxy or firewall.

Codebuff respects standard proxy environment variables. Set `HTTPS_PROXY` to route traffic through your proxy:

**Linux / macOS (bash/zsh):**
```bash
export HTTPS_PROXY=http://your-proxy-server:port
codebuff
```

**Windows (PowerShell):**
```powershell
$env:HTTPS_PROXY = "http://your-proxy-server:port"
codebuff
```

**Windows (CMD):**
```cmd
set HTTPS_PROXY=http://your-proxy-server:port
codebuff
```

To make it permanent, add the `export` or `set` line to your shell profile (e.g. `~/.bashrc`, `~/.zshrc`, or Windows System Environment Variables).

**Supported environment variables:**

| Variable | Purpose |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS requests (recommended) |
| `HTTP_PROXY` / `http_proxy` | Fallback proxy for HTTP requests |
| `NO_PROXY` / `no_proxy` | Comma-separated list of hostnames to bypass the proxy (port suffixes are ignored) |

Both `http://` and `https://` proxy URLs are supported. Proxy authentication is supported via URL credentials (e.g. `http://user:password@proxy:port`).

## Feedback

We value your input! Please email your feedback to `founders@freebuff.com`. Thank you for using Codebuff!
