import type { AgentDefinition } from './types/agent-definition'

const outputSchema = {
  type: 'object' as const,
  properties: {
    overallStatus: {
      type: 'string' as const,
      enum: ['success', 'failure', 'partial'],
      description: '"success" when all tasks completed, "failure" when the primary task could not be done, "partial" when some subtasks succeeded but others failed',
    },
    summary: {
      type: 'string' as const,
      description: 'Brief summary of the CLI interaction: what was done, key outputs observed, and the outcome',
    },
    sessionName: {
      type: 'string' as const,
      description: 'The tmux session name used for this run (needed for cleanup if the session lingers)',
    },
    results: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Short name of the task or interaction step' },
          passed: { type: 'boolean' as const, description: 'Whether this step succeeded' },
          details: { type: 'string' as const, description: 'What happened during this step' },
          capturedOutput: { type: 'string' as const, description: 'Relevant CLI output observed (keep concise — full output is in capture files)' },
        },
        required: ['name', 'passed'],
      },
      description: 'Ordered list of interaction steps and their outcomes',
    },
    scriptIssues: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          script: { type: 'string' as const, description: 'Which helper command had the issue (e.g., "send", "capture", "wait-idle")' },
          issue: { type: 'string' as const, description: 'What went wrong when using the helper script' },
          errorOutput: { type: 'string' as const, description: 'The actual error message or unexpected output' },
          suggestedFix: { type: 'string' as const, description: 'Suggested fix for the parent agent to implement' },
        },
        required: ['script', 'issue', 'suggestedFix'],
      },
      description: 'Problems encountered with the helper script that the parent agent should address',
    },
    captures: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const, description: 'Absolute path to the capture file in /tmp/tmux-captures-{session}/' },
          label: { type: 'string' as const, description: 'Descriptive label for what this capture shows (e.g., "after-login", "error-state", "final")' },
          timestamp: { type: 'string' as const, description: 'ISO 8601 timestamp of when the capture was taken' },
        },
        required: ['path', 'label'],
      },
      description: 'Saved terminal captures the parent agent can read to verify results',
    },
    lessons: {
      type: 'array' as const,
      items: {
        type: 'string' as const,
      },
      description: 'Advice for future runs: timing adjustments needed, unexpected CLI behavior, workarounds discovered, input quirks',
    },
  },
  required: ['overallStatus', 'summary', 'sessionName', 'scriptIssues', 'captures'],
}

const definition: AgentDefinition = {
  id: 'tmux-cli',
  displayName: 'Tmux CLI Agent',
  model: 'minimax/minimax-m2.7',
  // Provider options are tightly coupled to the model choice above.
  // If you change the model, update these accordingly.
  providerOptions: {
    data_collection: 'deny',
  },

  spawnerPrompt: `General-purpose agent that uses tmux to interact with and test CLI applications.

**Your responsibilities as the parent agent:**
1. If \`scriptIssues\` is not empty, check the error details and re-run the agent
2. Use \`read_files\` on the capture paths to see what the CLI displayed
3. Re-run the agent after fixing any issues
4. Check the \`lessons\` array for advice on how to improve future runs

**Note:** Capture files are saved to \`/tmp/\`. Use \`run_terminal_command\` with \`cat\` to read them if \`read_files\` doesn't support absolute paths.

**When spawning this agent**, provide as much advice as possible in the prompt about how to test the CLI, including lessons from any previous runs of tmux-cli (e.g., timing adjustments, commands that didn't work, expected output patterns). This helps the agent avoid repeating mistakes.

**Orphaned session cleanup:** If the agent fails or times out, the tmux session may linger. Run \`tmux kill-session -t <sessionName>\` to clean up. The session name is in the agent's output.`,

  inputSchema: {
    prompt: {
      type: 'string',
      description: 'What to do with the CLI application (e.g., "run /help and verify output", "send a prompt and capture the response")',
    },
    params: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The CLI command to start in the tmux session (e.g., "python app.py", "node server.js", "my-cli --interactive")',
        },
      },
    },
  },

  outputMode: 'structured_output',
  outputSchema,
  includeMessageHistory: false,

  toolNames: ['run_terminal_command', 'read_files', 'set_output', 'add_message'],

  systemPrompt: `You are an expert at interacting with CLI applications via tmux. You start a CLI process in a tmux session and use a helper script to send input and capture output.

## Session Management

A tmux session is started for you automatically. The session name and helper script path will be announced in a setup message. Do NOT start a new session — use the one provided.

The session runs \`bash\` and your command is sent to it automatically. This means the session stays alive even if the command exits.

## Helper Script Reference

The examples below use \`$HELPER\` and \`$SESSION\` as shorthand. The **actual paths** will be provided in the setup message when the session starts. Always use those real paths in your commands.

### Sending Input

\`\`\`bash
# Send input (presses Enter automatically)
$HELPER send "$SESSION" "your input here"

# Send without pressing Enter
$HELPER send "$SESSION" "partial text" --no-enter

# Send with bracketed paste mode (for TUI apps: vim, fzf, Ink-based CLIs)
$HELPER send "$SESSION" "pasted content" --paste

# Send and wait for output to stabilize (for streaming CLIs)
$HELPER send "$SESSION" "command" --wait-idle 3

# Send special keys (Enter, Escape, C-c, C-u, Up, Down, Tab, etc.)
$HELPER key "$SESSION" Escape
$HELPER key "$SESSION" C-c

# Pass arguments directly to tmux send-keys (escape hatch)
$HELPER raw "$SESSION" "some text" Enter
\`\`\`

Input is sent as **plain text** by default (works for \`input()\`, readline, most CLIs). For TUI apps that need paste events, add \`--paste\`.

### Capturing Output

\`\`\`bash
# Capture visible pane (~30 lines). Default wait: 1 second.
$HELPER capture "$SESSION"

# Capture with a descriptive label (used in the filename)
$HELPER capture "$SESSION" --label "after-login"

# Capture with custom wait time
$HELPER capture "$SESSION" --wait 3

# Capture full scrollback (use for final capture)
$HELPER capture "$SESSION" --full --label "final"

# Capture with ANSI color codes stripped (cleaner for parsing)
$HELPER capture "$SESSION" --strip-ansi --label "clean-output"

# Instant capture (no wait)
$HELPER capture "$SESSION" --wait 0
\`\`\`

Captures show the **visible pane** by default. Add \`--full\` for the entire scrollback buffer. Each capture is saved to a file in \`/tmp/tmux-captures-{session}/\` and the path + content are printed. A timestamp is included in the output.

### Waiting

\`\`\`bash
# Wait until output is stable for N seconds (max 120s)
$HELPER wait-idle "$SESSION" 3
\`\`\`

### Session Control

\`\`\`bash
# Check if session is alive
$HELPER status "$SESSION"

# Stop the session
$HELPER stop "$SESSION"
\`\`\`

## File Creation

Do NOT send file content through the tmux session. Use \`run_terminal_command\` with heredocs or scripting to create/edit files. The tmux session is for interacting with the CLI being tested.

## Error Recovery

If the CLI appears hung, try \`$HELPER key "$SESSION" C-c\` to interrupt. If it's still unresponsive, check session status with \`$HELPER status "$SESSION"\`. If the session is dead, report the failure. Always capture before stopping so the parent agent can diagnose issues.

## Operating Heuristics

- Use the provided tmux session as the single source of truth. Do not start a second session.
- **Capture discipline:** Aim for 3-8 captures per run. Capture at key milestones: startup, after important interactions, on errors, and final state. Do NOT capture after every single input.
- **Use \`--full\` on the final capture** to get complete scrollback history. Regular captures only show the visible pane (~30 lines), keeping them small and focused.
- **Wait guidance:** Most CLIs need 1-2 seconds to process input. Use \`--wait-idle 2\` on send or \`--wait 2\` on capture. For streaming CLIs, use \`--wait-idle 3\` or higher. Use \`wait-idle\` to wait for output to stabilize before sending more input.
- Use \`--label\` on captures to make filenames descriptive.
- If the CLI already shows enough evidence in the current viewport, do not keep recapturing.`,

  instructionsPrompt: `Instructions:

## Workflow

A tmux session has been started for you. A setup message will announce the session name, helper script path, and the initial terminal output. Your command has already been sent to the session.

1. **Check the initial output** provided in the setup message. If you see errors like "command not found" or "No such file", report failure immediately.
2. **Interact with the CLI** using the helper commands documented in the system prompt (send, key, capture, wait-idle, etc.).
3. **Capture output** at key milestones. Use \`wait-idle\` to wait for output to stabilize before sending more input.
4. **Final capture** with full scrollback before stopping: \`$HELPER capture "$SESSION" --full --label "final"\`
5. **Stop the session**: \`$HELPER stop "$SESSION"\`

## Output

Report results using set_output with:
- \`overallStatus\`: "success" (all tasks completed), "failure" (primary task couldn't be done), or "partial" (some subtasks succeeded but others failed)
- \`summary\`: Brief description of what was done
- \`sessionName\`: The tmux session name (REQUIRED)
- \`results\`: Array of task outcomes
- \`scriptIssues\`: Array of any problems with the helper script
- \`captures\`: Array of capture paths with labels. Use the file paths printed by the capture command (MUST have at least one)
- \`lessons\`: Array of strings describing issues encountered and advice for future runs (e.g., "Need longer --wait for this CLI", "CLI requires pressing Enter twice", "Command X produced unexpected output")

Always include captures so the parent agent can verify results. Always include lessons so future invocations can be improved.`,

  handleSteps: function* ({ params, logger }) {
    // Self-contained tmux helper script written to /tmp at startup.
    // Must be defined inside handleSteps because the function is serialized.
    const helperScript = `#!/usr/bin/env bash
set -e

usage() {
  echo "Usage: $0 <command> [args]"
  echo "Commands: start, send, capture, stop, key, raw, wait-idle, status"
  exit 1
}

[[ $# -lt 1 ]] && usage
CMD="$1"; shift

case "$CMD" in
  start)
    SESSION="$1"
    [[ -z "$SESSION" ]] && { echo "Usage: start <session>" >&2; exit 1; }
    tmux new-session -d -s "$SESSION" -x 120 -y 30 bash 2>/dev/null || true
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Failed to create session $SESSION" >&2; exit 1
    fi
    mkdir -p "/tmp/tmux-captures-$SESSION"
    echo "$SESSION"
    ;;

  send)
    # send <session> <text> [--no-enter] [--paste] [--wait-idle N]
    SESSION="$1"; shift
    TEXT=""; AUTO_ENTER=true; PASTE_MODE=false; WAIT_IDLE=0
    while [[ $# -gt 0 ]]; do
      case $1 in
        --no-enter) AUTO_ENTER=false; shift ;;
        --paste) PASTE_MODE=true; shift ;;
        --wait-idle) WAIT_IDLE="$2"; shift 2 ;;
        *) TEXT="$1"; shift ;;
      esac
    done
    [[ -z "$SESSION" || -z "$TEXT" ]] && { echo "Usage: send <session> <text> [--no-enter] [--paste] [--wait-idle N]" >&2; exit 1; }
    tmux send-keys -t "$SESSION" C-u
    sleep 0.05
    if [[ "$PASTE_MODE" == true ]]; then
      tmux send-keys -t "$SESSION" $'\\x1b[200~'"$TEXT"$'\\x1b[201~'
    else
      tmux send-keys -t "$SESSION" -- "$TEXT"
    fi
    if [[ "$AUTO_ENTER" == true ]]; then
      sleep 0.05
      tmux send-keys -t "$SESSION" Enter
      sleep 0.5
    fi
    if [[ "$WAIT_IDLE" -gt 0 ]]; then
      LAST_OUTPUT=""
      STABLE_START=$(date +%s)
      MAX_END=$(( $(date +%s) + 120 ))
      while true; do
        CURRENT_OUTPUT=$(tmux capture-pane -t "$SESSION" -S - -p 2>/dev/null || echo "")
        NOW=$(date +%s)
        if [[ "$CURRENT_OUTPUT" != "$LAST_OUTPUT" ]]; then
          LAST_OUTPUT="$CURRENT_OUTPUT"
          STABLE_START=$NOW
        fi
        if (( NOW - STABLE_START >= WAIT_IDLE )); then break; fi
        if (( NOW >= MAX_END )); then echo "wait-idle timed out after 120s" >&2; break; fi
        sleep 0.25
      done
    fi
    ;;

  key)
    SESSION="$1"; KEY="$2"
    [[ -z "$SESSION" || -z "$KEY" ]] && { echo "Usage: key <session> <key>" >&2; exit 1; }
    tmux send-keys -t "$SESSION" "$KEY"
    ;;

  raw)
    SESSION="$1"; shift
    [[ -z "$SESSION" ]] && { echo "Usage: raw <session> [tmux send-keys args...]" >&2; exit 1; }
    tmux send-keys -t "$SESSION" "$@"
    ;;

  capture)
    # capture <session> [--wait N] [--label LABEL] [--full] [--strip-ansi]
    SESSION="$1"; shift
    WAIT=1; LABEL=""; FULL=false; STRIP_ANSI=false
    while [[ $# -gt 0 ]]; do
      case $1 in
        --wait) WAIT="$2"; shift 2 ;;
        --label) LABEL="$2"; shift 2 ;;
        --full) FULL=true; shift ;;
        --strip-ansi) STRIP_ANSI=true; shift ;;
        *) shift ;;
      esac
    done
    [[ -z "$SESSION" ]] && { echo "Usage: capture <session> [--wait N] [--label LABEL] [--full] [--strip-ansi]" >&2; exit 1; }
    [[ "$WAIT" -gt 0 ]] && sleep "$WAIT"
    CAPTURE_DIR="/tmp/tmux-captures-$SESSION"
    mkdir -p "$CAPTURE_DIR"
    SEQ_FILE="$CAPTURE_DIR/.seq"
    if [[ -f "$SEQ_FILE" ]]; then SEQ=$(cat "$SEQ_FILE"); else SEQ=0; fi
    SEQ=$((SEQ + 1))
    echo "$SEQ" > "$SEQ_FILE"
    SEQ_PAD=$(printf "%03d" "$SEQ")
    if [[ -n "$LABEL" ]]; then
      CAPTURE_FILE="$CAPTURE_DIR/capture-\${SEQ_PAD}-\${LABEL}.txt"
    else
      CAPTURE_FILE="$CAPTURE_DIR/capture-\${SEQ_PAD}.txt"
    fi
    if [[ "$FULL" == true ]]; then
      tmux capture-pane -t "$SESSION" -S - -p > "$CAPTURE_FILE"
    else
      tmux capture-pane -t "$SESSION" -p > "$CAPTURE_FILE"
    fi
    if [[ "$STRIP_ANSI" == true ]]; then
      perl -pe 's/\\e\\[[\\d;]*[a-zA-Z]//g' "$CAPTURE_FILE" > "$CAPTURE_FILE.tmp" && mv "$CAPTURE_FILE.tmp" "$CAPTURE_FILE"
    fi
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo "[Saved: $CAPTURE_FILE] [$TIMESTAMP]"
    cat "$CAPTURE_FILE"
    ;;

  wait-idle)
    # wait-idle <session> [stable-seconds]
    SESSION="$1"; STABLE_SECS="\${2:-2}"
    [[ -z "$SESSION" ]] && { echo "Usage: wait-idle <session> [seconds]" >&2; exit 1; }
    LAST_OUTPUT=""
    STABLE_START=$(date +%s)
    MAX_END=$(( $(date +%s) + 120 ))
    while true; do
      CURRENT_OUTPUT=$(tmux capture-pane -t "$SESSION" -S - -p 2>/dev/null || echo "")
      NOW=$(date +%s)
      if [[ "$CURRENT_OUTPUT" != "$LAST_OUTPUT" ]]; then
        LAST_OUTPUT="$CURRENT_OUTPUT"
        STABLE_START=$NOW
      fi
      if (( NOW - STABLE_START >= STABLE_SECS )); then echo "Output stable for \${STABLE_SECS}s"; break; fi
      if (( NOW >= MAX_END )); then echo "Timed out after 120s" >&2; break; fi
      sleep 0.25
    done
    ;;

  status)
    SESSION="$1"
    [[ -z "$SESSION" ]] && { echo "Usage: status <session>" >&2; exit 1; }
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "alive"
    else
      echo "dead"
    fi
    ;;

  stop)
    SESSION="$1"
    [[ -z "$SESSION" ]] && { echo "Usage: stop <session>" >&2; exit 1; }
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    ;;

  *) usage ;;
esac
`

    const startCommand = (params && typeof params.command === 'string') ? params.command : ''

    if (!startCommand) {
      logger.error('No command provided in params.command')
      yield {
        toolName: 'set_output',
        input: {
          overallStatus: 'failure',
          summary: 'No command provided. Pass params.command with the CLI command to start.',
          sessionName: '',
          scriptIssues: [],
          captures: [],
        },
      }
      return
    }

    // Generate a unique session name
    const sessionName = 'tui-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    const helperPath = '/tmp/tmux-helper-' + sessionName + '.sh'

    logger.info('Setting up tmux session: ' + sessionName)

    // Combined setup: write helper script, start session, send command (single yield to reduce round-trips)
    const escapedCommand = startCommand.replace(/'/g, "'\\''")
    const setupScript =
      'set -e\n' +
      'cat > ' + helperPath + " << 'TMUX_HELPER_EOF'\n" + helperScript + 'TMUX_HELPER_EOF\n' +
      'chmod +x ' + helperPath + '\n' +
      'OUTPUT=$(' + helperPath + " start '" + sessionName + "') || { echo \"FAIL_START\" >&2; exit 1; }\n" +
      helperPath + " send '" + sessionName + "' '" + escapedCommand + "' || { " + helperPath + " stop '" + sessionName + "' 2>/dev/null; echo \"FAIL_SEND\" >&2; exit 1; }\n" +
      'echo "$OUTPUT"'

    const { toolResult: setupResult } = yield {
      toolName: 'run_terminal_command',
      input: {
        command: setupScript,
        timeout_seconds: 30,
      },
      includeToolCall: false,
    }

    let setupSuccess = false
    let setupError = ''

    const setupOutput = setupResult?.[0]
    if (setupOutput && setupOutput.type === 'json') {
      const value = setupOutput.value as Record<string, unknown>
      const stdout = typeof value?.stdout === 'string' ? value.stdout.trim() : ''
      const stderr = typeof value?.stderr === 'string' ? value.stderr.trim() : ''
      const exitCode = typeof value?.exitCode === 'number' ? value.exitCode : undefined

      if (exitCode === 0 && stdout === sessionName) {
        setupSuccess = true
      } else {
        setupError = stderr || stdout || 'Setup failed with no error message'
      }
    } else {
      setupError = 'Unexpected result type from run_terminal_command'
    }

    if (!setupSuccess) {
      const isSendFailure = setupError.includes('FAIL_SEND')
      const isStartFailure = setupError.includes('FAIL_START')

      let summary: string
      let suggestedFix: string
      if (isSendFailure) {
        summary = 'Started session but failed to send command. ' + setupError
        suggestedFix = 'Check that the command is valid.'
      } else if (isStartFailure) {
        summary = 'Failed to start tmux session. ' + setupError
        suggestedFix = 'Ensure tmux is installed and the command is valid.'
      } else {
        summary = 'Failed to write helper script to /tmp. ' + setupError
        suggestedFix = 'Check /tmp is writable'
      }

      logger.error(setupError, 'Setup failed')
      yield {
        toolName: 'set_output',
        input: {
          overallStatus: 'failure',
          summary,
          sessionName: isSendFailure ? sessionName : '',
          scriptIssues: [{ script: helperPath, issue: setupError, suggestedFix }],
          captures: [],
        },
      }
      return
    }

    logger.info('Session ready: ' + sessionName)

    // Capture initial state so the agent starts with context (0.5s is enough since send already waits ~0.6s)
    const { toolResult: initCapture } = yield {
      toolName: 'run_terminal_command',
      input: {
        command: 'sleep 0.5 && ' + helperPath + " capture '" + sessionName + "' --wait 0 --label startup-check",
        timeout_seconds: 10,
      },
    }

    let initialOutput = '(no initial capture available)'
    const initResult = initCapture?.[0]
    if (initResult && initResult.type === 'json') {
      const initValue = initResult.value as Record<string, unknown>
      if (typeof initValue?.stdout === 'string' && initValue.stdout.trim()) {
        initialOutput = initValue.stdout.trim()
      }
    }

    const captureDir = '/tmp/tmux-captures-' + sessionName

    yield {
      toolName: 'add_message',
      input: {
        role: 'user',
        content: 'A tmux session has been started and `' + startCommand + '` has been sent to it.\n\n' +
          '**Session:** `' + sessionName + '`\n' +
          '**Helper:** `' + helperPath + '`\n' +
          '**Captures dir:** `' + captureDir + '/`\n\n' +
          '**Initial terminal output:**\n```\n' + initialOutput + '\n```\n\n' +
          'Check the initial output above — if you see errors like "command not found" or "No such file", report failure immediately.\n\n' +
          '## Helper Script Implementation\n\n' +
          'The helper script at `' + helperPath + '` is a Bash script that wraps tmux commands to interact with the CLI. Here is its full implementation:\n\n' +
          '```bash\n' + helperScript.replace(/```/g, '\\`\\`\\`') + '\n```\n\n' +
          '## Quick Reference\n\n' +
          '- Send input: `' + helperPath + ' send "' + sessionName + '" "..."`\n' +
          '- Send with paste mode: `' + helperPath + ' send "' + sessionName + '" "..." --paste`\n' +
          '- Send + wait for output: `' + helperPath + ' send "' + sessionName + '" "..." --wait-idle 3`\n' +
          '- Send key: `' + helperPath + ' key "' + sessionName + '" C-c`\n' +
          '- Raw tmux send-keys: `' + helperPath + ' raw "' + sessionName + '" "text" Enter`\n' +
          '- Capture visible pane: `' + helperPath + ' capture "' + sessionName + '" --label "..."`\n' +
          '- Capture full scrollback: `' + helperPath + ' capture "' + sessionName + '" --full --label "final"`\n' +
          '- Capture without ANSI colors: `' + helperPath + ' capture "' + sessionName + '" --strip-ansi`\n' +
          '- Check session status: `' + helperPath + ' status "' + sessionName + '"`\n' +
          '- Wait for stable output: `' + helperPath + ' wait-idle "' + sessionName + '" 3`\n' +
          '- Stop session: `' + helperPath + ' stop "' + sessionName + '"`\n\n' +
          'Captures are saved to `' + captureDir + '/` — use the file paths in your output so the parent agent can verify with `read_files`.',
      },
      includeToolCall: false,
    }

    yield 'STEP_ALL'
  },
}

export default definition
