# focus-helper.ps1
# ---------------------------------------------------------------------------
# Focus Mode -- elevated helper. Runs as Administrator for one whole focus
# session. Started exactly once per session (that is the single UAC prompt).
#
# Two modes, picked by the "mode" field of the plan file:
#
#   mode = "session"  (default) -- one whole focus session
#     1. back up the original hosts file  (only if no backup exists yet)
#     2. write the new hosts text         (verbatim -- no text processing here)
#     3. kill the blacklisted processes   (loop, every few seconds)
#     4. restore the original hosts file, flush DNS, exit
#
#   mode = "restore" -- one shot cleanup of leftovers from a dead session
#     write the clean hosts text, flush DNS, exit. No backup, no loop.
#     (In this mode the file on disk is already dirty, so a backup would
#      capture our own block as "the original" and write it right back.)
#
# It deliberately does NOT parse or edit hosts text. All text logic lives in
# JS (src/main/focus/hosts.js) where it is unit tested. This script is a
# dumb writer: it copies a string in and a file out.
#
# Two ways out of the loop:
#   - the control file says stop for OUR session id  -> restore, exit 0
#   - wall clock passed endsAt                       -> restore, exit 0
# The second one is the self-heal path: if the main process dies, the machine
# still gets its hosts file back on time. No leftovers.
#
# Only ONE argument is passed in: the path of the plan file. Everything else
# (hosts path, backup path, control path, heartbeat path, log path, exe list)
# is read from that plan file. Fewer arguments = fewer quoting bugs.
#
# ---------------------------------------------------------------------------
# IMPORTANT: keep this file PURE ASCII. Windows PowerShell reads .ps1 files
# using the system ANSI code page when no BOM is present, so non-ASCII bytes
# get garbled and can break the lines that follow them. Same trap as the
# .bat / .vbs launcher scripts. Comments and messages stay English.
# ---------------------------------------------------------------------------

param(
  [Parameter(Mandatory = $true)][string]$PlanFile
)

$ErrorActionPreference = 'Continue'

# How often the loop wakes up. Kept short so a blacklisted app is closed
# within a few seconds of the user opening it.
$LoopSeconds = 3

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Log {
  param([string]$Message)
  if ([string]::IsNullOrEmpty($script:LogPath)) { return }
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $script:LogPath -Value ("[" + $stamp + "] " + $Message) -Encoding UTF8
  } catch { }
}

function Read-Json {
  param([string]$Path)
  try {
    if ([string]::IsNullOrEmpty($Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Json {
  param([string]$Path, $Object)
  try {
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    $json = $Object | ConvertTo-Json -Depth 6 -Compress
    # UTF-8 without BOM: the main process reads it back with plain JSON.parse.
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $enc)
    return $true
  } catch {
    return $false
  }
}

# The hosts file is written through code page 28591 (ISO-8859-1) on purpose:
# that maps one byte to one character, so a read -> edit -> write cycle is
# byte exact for ANY original content. The JS side reads and writes hosts the
# same way. This means we never re-encode a hosts file that was saved as ANSI
# or as UTF-8 -- either way, every byte the user did not touch comes back
# identical.
function Write-HostsText {
  param([string]$Text)
  $enc = [System.Text.Encoding]::GetEncoding(28591)
  [System.IO.File]::WriteAllText($script:HostsPath, $Text, $enc)
}

function Invoke-FlushDns {
  try { & ipconfig.exe /flushdns | Out-Null } catch { }
}

function Restore-Hosts {
  # Prefer the byte exact backup (a straight file copy). Fall back to the
  # precomputed restore text if the backup somehow went missing.
  try {
    if ((-not [string]::IsNullOrEmpty($script:BackupPath)) -and (Test-Path -LiteralPath $script:BackupPath)) {
      Copy-Item -LiteralPath $script:BackupPath -Destination $script:HostsPath -Force
      Write-Log 'hosts restored from backup'
      # Backup is single-use: drop it so the next session takes a fresh one.
      Remove-Item -LiteralPath $script:BackupPath -Force -ErrorAction SilentlyContinue
    } elseif ($null -ne $script:RestoreText) {
      Write-HostsText ([string]$script:RestoreText)
      Write-Log 'hosts restored from precomputed text'
    } else {
      Write-Log 'WARN: no backup and no restore text -- nothing to restore'
    }
  } catch {
    Write-Log ('ERROR restoring hosts: ' + $_.Exception.Message)
  }
  Invoke-FlushDns
}

# ---------------------------------------------------------------------------
# 0. Read and validate the plan. Anything missing -> leave the system alone.
# ---------------------------------------------------------------------------

$plan = Read-Json $PlanFile
if ($null -eq $plan) {
  exit 2
}

$script:HostsPath   = [string]$plan.hostsPath
$script:BackupPath  = [string]$plan.backupPath
$script:CtlPath     = [string]$plan.ctlPath
$script:HbPath      = [string]$plan.hbPath
$script:LogPath     = [string]$plan.logPath
$script:RestoreText = $plan.restoreText

$sid = [string]$plan.sid
$exes = @($plan.exes)

$endsAt = 0
try { $endsAt = [int64]$plan.endsAt } catch { $endsAt = 0 }

if ([string]::IsNullOrEmpty($script:HostsPath) -or [string]::IsNullOrEmpty($sid) -or ($endsAt -le 0)) {
  Write-Log 'ERROR: plan is incomplete, refusing to touch the system'
  exit 2
}

Write-Log ('helper started pid=' + $PID + ' sid=' + $sid + ' mode=' + [string]$plan.mode + ' exes=' + ($exes -join ','))

# ---------------------------------------------------------------------------
# One-shot mode: write the clean text and leave.
#
# Used to clean up leftovers from a session that died (machine rebooted, or the
# elevated process was killed). In this mode the hosts file on disk is the DIRTY
# one, so the normal backup/restore dance would be exactly wrong: the backup
# would capture our own block as "the original", and the restore at the end
# would write it straight back. So: no backup, no loop. Just write and exit.
# ---------------------------------------------------------------------------

if ([string]$plan.mode -eq 'restore') {
  if ($null -eq $plan.hostsText) {
    Write-Log 'ERROR: restore mode but no hostsText in plan'
    exit 2
  }
  try {
    Write-HostsText ([string]$plan.hostsText)
    Write-Log 'hosts cleaned up (one shot)'
    Invoke-FlushDns
    exit 0
  } catch {
    Write-Log ('ERROR one shot cleanup: ' + $_.Exception.Message)
    exit 3
  }
}

# ---------------------------------------------------------------------------
# 1. Back up the original hosts -- only when there is no backup yet.
#    Never overwrite an existing backup: a leftover backup from a crashed
#    session is the true "before" state, and overwriting it would bake our
#    own block into the file we later restore from.
# ---------------------------------------------------------------------------

try {
  if (Test-Path -LiteralPath $script:BackupPath) {
    Write-Log 'backup already present, kept as is'
  } else {
    Copy-Item -LiteralPath $script:HostsPath -Destination $script:BackupPath -Force
    Write-Log 'hosts backed up'
  }
} catch {
  Write-Log ('ERROR backing up hosts: ' + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 2. Write the new hosts text, exactly as JS computed it.
# ---------------------------------------------------------------------------

try {
  if ($null -ne $plan.hostsText) {
    Write-HostsText ([string]$plan.hostsText)
    Write-Log 'hosts written'
  }
} catch {
  Write-Log ('ERROR writing hosts: ' + $_.Exception.Message)
}

Invoke-FlushDns

# ---------------------------------------------------------------------------
# 3 + 4. Loop: kill blacklisted apps / watch for stop / watch the deadline.
# ---------------------------------------------------------------------------

# Second line of defence. The JS side already filters this list before it
# reaches us, but if it ever got it wrong we must not take the machine down.
# Killing any of these means a blue screen, a dead desktop, or a dead session.
$guard = @(
  'explorer', 'csrss', 'winlogon', 'lsass', 'services', 'wininit', 'smss',
  'dwm', 'svchost', 'taskhostw', 'sihost', 'fontdrvhost', 'ctfmon',
  'spoolsv', 'audiodg', 'searchindexer', 'startmenuexperiencehost',
  'shellexperiencehost', 'runtimebroker',
  'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'wsmprovhost',
  'reg', 'wmic', 'msiexec', 'taskmgr',
  'electron', 'node'
)

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  # a) Did the main process ask us to stop? Only honour OUR session id, so a
  #    stale control file from a previous session cannot end this one.
  $ctl = Read-Json $script:CtlPath
  if ($null -ne $ctl) {
    if (([string]$ctl.sid -eq $sid) -and ($ctl.stop -eq $true)) {
      Write-Log 'stop requested by main process'
      Restore-Hosts
      Write-Log 'helper exiting (stopped)'
      exit 0
    }
  }

  # b) Deadline reached -> self heal. This is the path taken when the main
  #    process crashed and nobody wrote a stop request.
  if ($now -ge $endsAt) {
    Write-Log 'deadline reached, self healing'
    Restore-Hosts
    Write-Log 'helper exiting (deadline)'
    exit 0
  }

  # c) Close anything on the blacklist.
  $killed = 0
  foreach ($entry in $exes) {
    $name = ([string]$entry).Trim().ToLower()
    if ($name -eq '') { continue }

    $base = $name
    if ($base.EndsWith('.exe')) { $base = $base.Substring(0, $base.Length - 4) }
    if ($base -eq '') { continue }
    if ($guard -contains $base) { continue }

    # -Name with a literal process name: no string building, no surprises.
    $procs = @(Get-Process -Name $base -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        $killed = $killed + 1
        Write-Log ('killed ' + $name + ' pid=' + $p.Id)
      } catch { }
    }
  }

  # d) Heartbeat so the main process can tell we are still alive.
  Write-Json $script:HbPath @{ sid = $sid; at = $now; killed = $killed; pid = $PID } | Out-Null

  Start-Sleep -Seconds $LoopSeconds
}
