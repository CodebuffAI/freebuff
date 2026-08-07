# Codebuff for Linux

Common Linux-specific issues and solutions.

## Issue: CLI interactive menu freezes on Enter

**Symptom**: Arrow keys work in menus, but pressing Enter does nothing — the CLI hangs.

**Affected terminals**: KDE Konsole, some older terminal emulators.

**Solutions**:

1. **Use a different terminal emulator**:
   - GNOME Terminal (most reliable)
   - Alacritty
   - Kitty

2. **Check terminal settings**:
   - Ensure terminal is set to use UTF-8 encoding
   - Check that alternate screen buffer is enabled

3. **Use tmux**:
   ```bash
   tmux new-session -s codebuff
   codebuff
   ```

**Reference**: Issue [#775](https://github.com/CodebuffAI/codebuff/issues/775)

---

## Issue: Path-sandbox error for skills

**Symptom**: `[FILE_OUTSIDE_PROJECT]` error when executing skills that reference files in `~/.agents/skills/`.

**Cause**: The SDK's path validation blocks reads outside the project root. Skills stored in `~/.agents/skills/` are outside the project.

**Workaround**: Copy skill files into your project directory before execution.

**Reference**: Issue [#767](https://github.com/CodebuffAI/codebuff/issues/767)

---

## Issue: SIGILL on older CPUs

**Symptom**: `linux-x64-baseline` binary crashes with illegal instruction on CPUs without AVX support.

**Cause**: The baseline build target may still contain AVX instructions due to Bun's compilation.

**Workaround**: Use the standard `linux-x64` target if your CPU supports AVX, or wait for a fix.

**Reference**: Issue [#797](https://github.com/CodebuffAI/codebuff/issues/797)

---

## General Linux Troubleshooting

### Check terminal capabilities
```bash
echo $TERM
echo $LANG
```

### Test keyboard input
```bash
cat -v
# Press keys to see their escape sequences
```

### Check Node.js version
```bash
node --version
# Recommended: Node 20.x LTS or newer
```
