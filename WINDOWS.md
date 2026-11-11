# Codebuff on Windows

## Set-up guide

How to get from a blank Windows install to a Codebuff install.

Surprisingly: most guides in fact recommend running everything in an Admin PowerShell, contra to advice to not use sudo on eg: Linux/macOS.

- Install Choco: Open PowerShell as Admin, and run the command from https://chocolatey.org/install
- Install NVM: Restart PowerShell (still as Admin) and run `choco install nvm -y`
- Install Node: Restart PowerShell (still as Admin) and run `nvm install node`
- Install Codebuff: Run `npm i -g codebuff`

---

## Common Windows Issues & Troubleshooting

Running into problems? Here are solutions to the most common Windows-specific issues.

### Issue: "Failed to determine latest version" on First Run

**Symptom**:
```powershell
PS C:\> codebuff
❌ Failed to determine latest version
Please check your internet connection and try again
```

**Cause**:
Codebuff checks GitHub for the latest release on first run. This fails when:
- Corporate firewall blocks `github.com`
- Proxy settings not configured
- Network connectivity issues
- VPN required for external access

**Solutions**:

1. **Set the `HTTPS_PROXY` environment variable** (if behind corporate proxy):

   Codebuff natively supports proxy environment variables. This is the recommended fix:

   **PowerShell:**
   ```powershell
   $env:HTTPS_PROXY = "http://your-proxy-server:port"
   codebuff
   ```

   **CMD:**
   ```cmd
   set HTTPS_PROXY=http://your-proxy-server:port
   codebuff
   ```

   To make it permanent, add `HTTPS_PROXY` to your Windows System Environment Variables (Settings → System → Advanced → Environment Variables).

2. **Verify network access**:
   ```powershell
   curl https://registry.npmjs.org/codebuff/latest
   ```
   If this fails, you have a network/firewall issue.

3. **Configure npm proxy** (for the `npm install` step only):
   ```powershell
   npm config set proxy http://your-proxy-server:port
   npm config set https-proxy http://your-proxy-server:port
   ```
   Note: This only helps with `npm install`. Codebuff's own downloads use `HTTPS_PROXY` instead.

4. **Disable VPN temporarily** or whitelist `registry.npmjs.org` and `codebuff.com` in your firewall

5. **Clear npm cache and reinstall**:
   ```powershell
   npm cache clean --force
   npm uninstall -g codebuff
   npm install -g codebuff
   ```

**Reference**: Issue [#294](https://github.com/CodebuffAI/codebuff/issues/294)

---

### Issue: "Bash is required but was not found" Error

**Symptom**:
```
Bash is required but was not found on this Windows system.
```

**Cause**:
Agents write bash, so bash is what we run. This error means we could not find one — Git for
Windows is the usual source of it.

**In Freebuff Desktop**: you should rarely see anything like this. The app looks in far more
places than the message above implies (see below), and when bash genuinely is missing it says so
with a card before your first prompt rather than failing mid-turn. The text above is the CLI's.
Either way the fix is the same, and the app picks up a new install without a restart.

**Solutions**:

1. **Install Git for Windows** (recommended):
   - Download from https://git-scm.com/download/win, or run
     `winget install --id Git.Git --exact --source winget`
   - Both the per-machine and per-user (no admin) installs are detected, as are Scoop and
     Chocolatey layouts, a `ProgramFiles` that isn't on C:, and any install that puts `git.exe`
     on PATH — bash is found beside it
   - Works in PowerShell, CMD, or Git Bash terminals

2. **Use WSL (Windows Subsystem for Linux)**:
   - Provides full Linux environment with native bash
   - Install: `wsl --install` in PowerShell (Admin)
   - Run codebuff inside WSL for best compatibility
   - Note: the WSL launcher at `C:\Windows\System32\bash.exe` is deliberately never used as our
     bash. It exists whether or not a distro does, and fails with unhelpful errors when there
     isn't one.

3. **Set custom bash path** (advanced):
   - For an install in a custom directory that also adds nothing to PATH (the installer's
     "Use Git from Git Bash only" option), this is the supported way to point at it. Nothing
     overwrites or clears the value once you set it:
   ```powershell
   set CODEBUFF_GIT_BASH_PATH=C:\path\to\bash.exe
   ```

**Reference**: Issue [#274](https://github.com/CodebuffAI/codebuff/issues/274)

---

### Issue: Git Commands Fail on Windows

**Symptom**:
Git operations (commit, rebase, complex commands) fail with syntax errors or unexpected behavior.

**Cause**:
Complex git commands may have issues with Windows path handling or shell escaping.

**Solutions**:

1. **Ensure Git for Windows is installed**:
   - Download from https://git-scm.com/download/win
   - Codebuff uses bash.exe from Git for Windows for command execution

2. **Use WSL for complex operations**:
   - Provides full Linux environment with native bash
   - Install: `wsl --install` in PowerShell (Admin)
   - Run codebuff inside WSL for best compatibility

**Reference**: Issue [#274](https://github.com/CodebuffAI/codebuff/issues/274)

---

### Issue: Login Browser Window Fails to Open

**Symptom**:
```
Press ENTER to open your browser and finish logging in...

Caught exception: Error: Executable not found in $PATH: "start"
Error: Executable not found in $PATH: "start"
TLCWeb > Unable to login. Please try again by typing "login" in the terminal.
```

**Cause**:
When running Codebuff in Git Bash (MINGW64), the `start` command is not available in PATH. The browser auto-open feature fails.

**Solutions**:

1. **Manually open the login URL** (easiest):
   - Codebuff displays the login URL after the error
   - Copy the full URL starting with `https://codebuff.com/login?auth_code=...`
   - Paste into your browser
   - Complete login in browser
   - Return to terminal - login will succeed

2. **Use native Windows terminals**:
   - PowerShell: `powershell`
   - Command Prompt: `cmd`
   - These have `start` command available

3. **Clear cache if login still fails** (per issue #299):
   ```powershell
   npm cache clean --force
   npm uninstall -g codebuff
   npm install -g codebuff
   ```

**Reference**: Issue [#299](https://github.com/CodebuffAI/codebuff/issues/299)

---

### Message: "Update available: error → [version]"

**What it means**:
This is **not an error** - it's an informational message indicating:
- Your local binary needs to be downloaded/updated
- "error" is a placeholder version (not a real error state)
- Codebuff will automatically download the correct version

**What to do**:
- Wait for the download to complete: "Download complete! Starting Codebuff..."
- If download fails, check your internet connection
- If it persists, try the solutions in "Failed to determine latest version" above

**Reference**: Issue [#299](https://github.com/CodebuffAI/codebuff/issues/299)

---

### Still Having Issues?

If these solutions don't resolve your problem:

1. **Search existing issues**: https://github.com/CodebuffAI/codebuff/issues
2. **Open a new issue**: https://github.com/CodebuffAI/codebuff/issues/new
3. **Join Discord community**: https://codebuff.com/discord

When reporting issues, please include:
- Windows version: `winver` command
- PowerShell/Git Bash/CMD
- Node version: `node --version`
- Full error message
- Steps to reproduce
