import { describe, expect, test } from 'bun:test'

import {
  inferHomeFolder,
  refusedUserFolderDelete,
  userFolderDeleteRefusal,
  type UserFolderDeleteContext,
} from './user-folder-delete'

const windowsHome = 'C:\\Users\\ana'
const windowsProject = 'C:\\Users\\ana\\code\\site'
const macHome = '/Users/ana'
const macProject = '/Users/ana/code/site'
const linuxHome = '/home/ana'

const windows = (cwd: string | null = windowsProject): UserFolderDeleteContext => ({
  platform: 'win32',
  cwd,
  home: windowsHome,
  env: {
    USERPROFILE: windowsHome,
    APPDATA: 'C:\\Users\\ana\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
    OneDrive: 'C:\\Users\\ana\\OneDrive',
    TEMP: 'C:\\Users\\ana\\AppData\\Local\\Temp',
  },
})
const mac = (cwd: string | null = macProject): UserFolderDeleteContext => ({
  platform: 'darwin',
  cwd,
  home: macHome,
  env: { HOME: macHome, TMPDIR: '/var/folders/x/T/' },
})
const linux = (cwd: string | null = '/home/ana/code/site'): UserFolderDeleteContext => ({
  platform: 'linux',
  cwd,
  home: linuxHome,
  env: { HOME: linuxHome },
})

const refused = (command: string, context: UserFolderDeleteContext) =>
  refusedUserFolderDelete(command, context)

// The command that ran, its user and folder names changed. A third-party skill's installer
// had walked up from the project, a folder inside Downloads, to a marker file in the home folder
// and installed there; the agent then cleaned up in the home folder by bare names.
const INCIDENT = 'echo "=== CLEANUP home ==="; cd /c/Users/ana; rm -f browser.py cli.py daemon.py snapshot.js snapshot_js.py pyproject.toml uv.lock; rm -rf .venv .codebuff/skills/browser-control; rmdir .codebuff/skills .codebuff 2>/dev/null; rm -rf shots downloads .freebuff-browser-profile; ls -d browser.py .venv .codebuff 2>&1\necho "=== INSTALL into project ==="; cd "/c/Users/ana/Downloads/My Project"; mkdir -p .codebuff/skills/browser-control'

describe('the 2026-11-25 incident', () => {
  test('the command as it ran, from the project folder inside Downloads', () => {
    expect(refused(INCIDENT, windows('C:\\Users\\ana\\Downloads\\My Project'))).toMatchObject({
      kind: 'user-folder',
      target: 'downloads',
      resolved: 'C:\\Users\\ana\\Downloads',
    })
  })

  test('and Cloud, which only knows the folder, refuses it too', () => {
    const project = 'C:\\Users\\ana\\Downloads\\My Project'
    expect(refused(INCIDENT, { platform: 'win32', cwd: project, home: inferHomeFolder('win32', project) })?.kind).toBe('user-folder')
  })

  test('cleaning the project inside Downloads still runs', () => {
    expect(refused('rm -rf shots downloads .venv', windows('C:\\Users\\ana\\Downloads\\My Project'))).toBeNull()
    expect(refused('rm -rf ../*', windows('C:\\Users\\ana\\Downloads\\My Project'))?.kind).toBe('user-folder-contents')
  })

  test('a lowercase name from the home folder is the real Downloads on Windows', () => {
    expect(refused('rm -rf shots downloads', windows(windowsHome))).toEqual({
      kind: 'user-folder',
      invocation: 'rm -rf',
      target: 'downloads',
      resolved: 'C:\\Users\\ana\\Downloads',
    })
  })

  test('and on macOS', () => {
    expect(refused('rm -rf shots downloads', mac(macHome))?.kind).toBe('user-folder')
  })

  test('Linux names are case-sensitive', () => {
    expect(refused('rm -rf shots downloads', linux(linuxHome))).toBeNull()
    expect(refused('rm -rf shots Downloads', linux(linuxHome))?.kind).toBe('user-folder')
  })

  test('the same cleanup inside the project runs', () => {
    expect(refused('rm -rf shots downloads', windows())).toBeNull()
    expect(refused('rm -rf shots downloads', mac())).toBeNull()
  })
})

describe('refuses', () => {
  const cases: [string, string, UserFolderDeleteContext][] = [
    ['tilde', 'rm -rf ~/Downloads', mac()],
    ['tilde alone', 'rm -rf ~', mac()],
    ['tilde with a trailing slash', 'rm -rf ~/Documents/', mac()],
    ['$HOME', 'rm -rf $HOME/Desktop', mac()],
    ['quoted "$HOME"', 'rm -rf "$HOME/Pictures"', mac()],
    ['${HOME}', 'rm -r -f ${HOME}/Music', linux()],
    ['--recursive', 'rm --recursive --force ~/Videos', linux()],
    ['-fr', 'rm -fr ~/Movies', mac()],
    ['-Rf', 'rm -Rf ~/Library', mac()],
    ['the home folder by its path', 'rm -rf /Users/ana', mac()],
    ['above home', 'rm -rf /Users', mac()],
    ['the root', 'rm -rf /', linux()],
    ['parent of the project, twice', 'rm -rf ../..', mac()],
    ['cd ~ earlier on the line', 'cd ~ && rm -rf downloads', mac()],
    ['cd "$HOME" then ;', 'cd "$HOME"; rm -rf Desktop', linux()],
    ['bare cd', 'cd; rm -rf Documents', mac()],
    ['sudo', 'sudo rm -rf ~/Downloads', mac()],
    ['bash -c', `bash -c 'rm -rf ~/Downloads'`, mac()],
    ['sh -lc', 'sh -lc "rm -rf \\"$HOME/Downloads\\""', mac()],
    ['eval', 'eval "rm -rf ~/Downloads"', mac()],
    ['command substitution', 'echo $(rm -rf ~/Downloads)', mac()],
    ['backticks', 'echo `rm -rf ~/Downloads`', mac()],
    ['brace expansion', 'rm -rf ~/{shots,Downloads}', mac()],
    ['everything in home', 'rm -rf ~/*', mac()],
    ['a glob that takes Downloads', 'cd ~ && rm -rf D*', mac()],
    ['everything in Downloads', 'rm -rf ~/Downloads/*', mac()],
    ['every home folder', 'rm -rf /Users/*', mac()],
    ['dotfile glob in home takes .ssh', 'rm -rf ~/.*', mac()],
    ['.ssh', 'rm -rf ~/.ssh', linux()],
    ['an assignment earlier on the line', 'DIR=~/Downloads; rm -rf "$DIR"', mac()],
    ['a backslash-escaped command', '\\rm -rf ~/Downloads', mac()],
    ['the absolute rm', '/bin/rm -rf ~/Downloads', mac()],
    ['npx rimraf', 'npx -y rimraf ~/Downloads', mac()],
    ['a redirect after the target', 'rm -rf ~/Downloads 2>/dev/null', mac()],
    ['an earlier command in a pipeline', 'ls && rm -rf ~/Downloads | tee log', mac()],
  ]
  for (const [name, command, context] of cases) {
    test(name, () => {
      expect(refused(command, context)).not.toBeNull()
    })
  }
})

describe('refuses on Windows', () => {
  const cases: [string, string][] = [
    ['backslash path in double quotes', 'rm -rf "C:\\Users\\ana\\Downloads"'],
    ['backslash path, escaped', 'rm -rf C:\\\\Users\\\\ana\\\\Downloads'],
    ['forward slashes', 'rm -rf C:/Users/ana/Downloads'],
    ['other case', 'rm -rf c:/users/ANA/downloads'],
    ['Git Bash drive path', 'rm -rf /c/Users/ana/Downloads'],
    ['$USERPROFILE', 'rm -rf "$USERPROFILE/Documents"'],
    ['%USERPROFILE% under cmd', 'cmd /c "rmdir /s /q %USERPROFILE%\\Downloads"'],
    ['cmd //c rd //s', 'cmd //c rd //s //q "%USERPROFILE%\\Desktop"'],
    ['del /s', 'cmd /c del /s /q %USERPROFILE%\\Pictures'],
    ['Remove-Item -Recurse', `powershell -NoProfile -Command "Remove-Item -Recurse -Force $env:USERPROFILE\\Downloads"`],
    ['Remove-Item -Path, -r', `powershell -Command 'Remove-Item -Path "$HOME\\Documents" -r'`],
    ['pwsh rm -r alias', `pwsh -c 'rm -r -fo ~\\Downloads'`],
    ['PowerShell EncodedCommand', `powershell -EncodedCommand ${Buffer.from('Remove-Item -Recurse $env:USERPROFILE\\Downloads', 'utf16le').toString('base64')}`],
    ['OneDrive', 'rm -rf "$OneDrive"'],
    ['OneDrive Documents', 'rm -rf "C:/Users/ana/OneDrive - Contoso/Documents"'],
    ['AppData', 'rm -rf ~/AppData'],
    ['%APPDATA% itself', 'cmd /c rd /s /q "%APPDATA%"'],
    ['$LOCALAPPDATA itself', 'rm -rf "$LOCALAPPDATA"'],
    ['the drive', 'cmd /c rd /s /q C:\\'],
    ['relative from home', 'rm -rf ./Desktop'],
    ['WSL into the Windows Downloads', 'wsl rm -rf /mnt/c/Users/ana/Downloads'],
  ]
  for (const [name, command] of cases) {
    test(name, () => {
      expect(refused(command, windows(name === 'relative from home' ? windowsHome : windowsProject))).not.toBeNull()
    })
  }
})

describe('allows', () => {
  const cases: [string, string, UserFolderDeleteContext][] = [
    ['inside the project', 'rm -rf node_modules dist .next', mac()],
    ['a project subfolder named like a user folder', 'rm -rf Downloads', mac()],
    ['an absolute path inside the project', 'rm -rf /Users/ana/code/site/shots', mac()],
    ['inside Downloads', 'rm -rf ~/Downloads/shots', mac()],
    ['a pattern inside Downloads that is not everything', 'rm -rf ~/Downloads/*.crdownload', mac()],
    ['a cache folder in home', 'rm -rf ~/.cache/ms-playwright', linux()],
    ['a skill folder in home', 'rm -rf ~/.agents/skills/browser', mac()],
    ['a folder in Library', 'rm -rf ~/Library/Caches/ms-playwright', mac()],
    ['temp', 'rm -rf "$TMPDIR/freebuff-shots"', mac()],
    ['/tmp', 'rm -rf /tmp/shots', linux()],
    ['the run’s own folder in home', 'rm -rf ~/freebuff-scratch', mac()],
    ['a non-user folder in home', 'cd ~ && rm -rf shots', mac()],
    ['not recursive', 'rm ~/Downloads', mac()],
    ['rm -d', 'rm -d ~/Downloads', mac()],
    ['rmdir without /s', 'rmdir ~/Downloads', mac()],
    ['a quoted mention', `echo 'rm -rf ~/Downloads'`, mac()],
    ['a quoted tilde is a literal folder', `rm -rf '~'`, mac()],
    ['a double-quoted tilde too', 'rm -rf "~/Downloads"', mac()],
    ['an unknown variable', 'rm -rf "$BUILD_DIR"', mac()],
    ['a command substitution target', 'rm -rf "$(mktemp -d)"', mac()],
    ['a relative name with no known working directory', 'rm -rf downloads', mac(null)],
    ['a subshell cd does not leak', '(cd ~ && ls) && rm -rf downloads', mac()],
    ['cd into the project from home', 'cd ~/code/site && rm -rf downloads', mac(macHome)],
    ['grep for the words', 'grep -r "rm -rf ~/Downloads" .', mac()],
    ['a heredoc body', 'cat <<EOF > notes.md\nrm -rf ~/Downloads\nEOF\nls', mac()],
    ['a comment', 'ls # rm -rf ~/Downloads', mac()],
    ['Remove-Item without -Recurse', `powershell -Command "Remove-Item $env:USERPROFILE\\Downloads\\a.zip"`, windows()],
    ['Remove-Item -WhatIf', `powershell -Command "Remove-Item -Recurse -WhatIf $env:USERPROFILE\\Downloads"`, windows()],
    ['inside the project on Windows', 'rm -rf "C:\\Users\\ana\\code\\site\\Downloads"', windows()],
    ['a Windows temp folder', 'rm -rf "$TEMP/shots"', windows()],
    ['a Playwright cache in LocalAppData', 'rm -rf "$LOCALAPPDATA/ms-playwright"', windows()],
    ['del of one pattern under the project', 'cmd /c del /s /q *.tmp', windows()],
    ['another user’s tilde', 'rm -rf ~bob/x', mac()],
    // From a real command, run from the home folder: a web app's `public` is not ~/Public.
    ['a web app’s public folder from the home folder', 'rm -rf api store public src', mac(macHome)],
  ]
  for (const [name, command, context] of cases) {
    test(name, () => {
      expect(refused(command, context)).toBeNull()
    })
  }
})

describe('Cloud without the computer’s home folder', () => {
  const cloud = (cwd: string, platform: string): UserFolderDeleteContext => ({
    platform,
    cwd,
    home: inferHomeFolder(platform, cwd),
  })

  test('the home folder is inferred from the folder a chat runs in', () => {
    expect(inferHomeFolder('win32', 'C:\\Users\\ana\\code')).toBe('C:\\Users\\ana')
    expect(inferHomeFolder('win32', 'c:/users/ana')).toBe('c:\\users\\ana')
    expect(inferHomeFolder('darwin', '/Users/ana/code')).toBe('/Users/ana')
    expect(inferHomeFolder('linux', '/home/ana/code')).toBe('/home/ana')
    expect(inferHomeFolder('darwin', '/Volumes/work/code')).toBeNull()
  })

  test('the incident is refused', () => {
    expect(refused('rm -rf shots downloads', cloud('C:\\Users\\ana', 'win32'))?.kind).toBe('user-folder')
  })

  test('an absolute target names its own home', () => {
    expect(refused('rm -rf /Users/ana/Downloads', cloud('/Volumes/work/code', 'darwin'))?.kind).toBe('user-folder')
  })

  test('tilde with no known home is let through', () => {
    expect(refused('rm -rf ~/Downloads', cloud('/Volumes/work/code', 'darwin'))).toBeNull()
  })
})

describe('the refusal', () => {
  test('says what it resolved to, why, and where to work instead', () => {
    const found = refused('rm -rf shots downloads', windows(windowsHome))!
    const message = userFolderDeleteRefusal(found, { platform: 'win32', projectRoot: windowsProject })
    expect(message).toContain('C:\\Users\\ana\\Downloads')
    expect(message).toContain('not case-sensitive')
    expect(message).toContain('Nothing ran')
    expect(message).toContain('C:/Users/ana/code/site/shots')
  })

  test('a chat whose folder is the home folder is told to make its own', () => {
    const found = refused('rm -rf shots downloads', windows(windowsHome))!
    expect(userFolderDeleteRefusal(found, { platform: 'win32', projectRoot: windowsHome })).toContain('freebuff-scratch')
  })
})
