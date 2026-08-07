## Codebuff for Windows dev setup

Welcome!

For development, we have a shared windows machine, via shadow.tech.

### Accessing the machine

You can access the machine either from the browser or with the desktop app:

1. Shadow.tech Web viewer:

- Go to https://pc.shadow.tech/home

2. Shadow.tech desktop app:

- They claim its better, idk.
- https://shadow.tech/download/

Supposedly you can also use Window's Remote Desktop to access the machine instead, but I've not tried it. Shadow.tech claims their protocol is better optimized for lower bandwidth use & hence smoother performance.

## Set-up guide:

You shouldn't need this - but just in case you stop using Shadow.tech, or make a new account, here's a guide on how to get from a blank Windows install to a Codebuff install.

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
Codebuff requires bash for command execution. On Windows, Codebuff looks for bash in this order:

1. `CODEBUFF_GIT_BASH_PATH` if you set it and the file exists.
2. Common Git for Windows locations such as `C:\Program Files\Git\bin\bash.exe`.
3. A non-WSL `bash.exe` or `bash` found on `PATH`.
4. WSL-provided bash paths as a last resort.

This error appears when Git for Windows is not installed, WSL is not available, or `bash.exe` cannot be found through those checks.

**Supported shells**:

- **PowerShell or Command Prompt with Git for Windows installed**: recommended for most Windows users.
- **Git Bash**: supported, but browser login auto-open may need the manual workaround below.
- **WSL**: supported when you install and run Codebuff inside the Linux distribution; WSL bash discovered from Windows `PATH` is only a fallback.

**Diagnostics**:

Run these from the same terminal where `codebuff` fails so the `PATH` matches Codebuff's environment:

```powershell
where.exe bash
Test-Path "C:\Program Files\Git\bin\bash.exe"
$env:PATH -split ';' | Select-String -Pattern 'Git|WindowsApps|System32'
```

If `where.exe bash` only prints `C:\Windows\System32\bash.exe` or a `WindowsApps` path, Windows is pointing Codebuff at the WSL launcher rather than Git Bash. That launcher can fail when WSL is not installed, the distro is stopped, or Windows-to-Linux quoting behaves differently.

**Solutions**:

1. **Install Git for Windows** (recommended):
   - Download from https://git-scm.com/download/win
   - Keep the default install location when possible: `C:\Program Files\Git\bin\bash.exe`
   - Restart PowerShell, CMD, Windows Terminal, or your IDE after installing so it reloads `PATH`
   - Verify with `where.exe bash`; a Git path should appear before any WSL path
   - Works in PowerShell, CMD, Windows Terminal, and Git Bash terminals

2. **Use WSL intentionally**:
   - Install WSL from an elevated PowerShell: `wsl --install`
   - Open your Linux distribution and install Node/npm inside WSL
   - Install Codebuff inside WSL with `npm install -g codebuff`
   - Run `codebuff` from the WSL shell, not from Windows PowerShell pointing at the WSL launcher
   - Keep the project under the WSL filesystem when possible for better file and shell behavior

3. **Pin the exact Git Bash executable** (advanced):
   - Use this when Git is installed in a custom location or another `bash.exe` appears earlier on `PATH`
   - For the current PowerShell session:
   ```powershell
   $env:CODEBUFF_GIT_BASH_PATH = "C:\Program Files\Git\bin\bash.exe"
   codebuff
   ```
   - For Command Prompt:
   ```cmd
   set CODEBUFF_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
   codebuff
   ```
   - To persist it for new terminals, add `CODEBUFF_GIT_BASH_PATH` in Windows Environment Variables or use `setx CODEBUFF_GIT_BASH_PATH "C:\Program Files\Git\bin\bash.exe"`

4. **Fix `PATH` ordering if the wrong bash is selected**:
   - Put `C:\Program Files\Git\bin` before `C:\Windows\System32` and WindowsApps entries only if you understand the system-wide impact
   - Prefer `CODEBUFF_GIT_BASH_PATH` if you only want to change Codebuff's behavior
   - Restart your terminal after changing environment variables

**When opening an issue about bash detection**, include the terminal type, Windows version, Codebuff version, the output of `where.exe bash`, whether Git for Windows or WSL is installed, and any `CODEBUFF_GIT_BASH_PATH` value you set.

**Reference**: Issues [#274](https://github.com/CodebuffAI/codebuff/issues/274) and [#819](https://github.com/CodebuffAI/codebuff/issues/819)

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
