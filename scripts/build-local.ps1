<#
.SYNOPSIS
    Build the DIG Browser locally and run it — no GitHub / CI round-trip.

.DESCRIPTION
    Produces a runnable dig.exe on THIS machine entirely from the locally-cached
    Chromium tarball (no network, no CI), then optionally launches it.

    WHY TWO STEPS (and a move): on Windows the source tree must be compiled from a
    SHORT path. The repo's build/src is deep enough to overrun MAX_PATH (260), which
    makes `gn gen` silently drop the longest generated ninja files and `ninja` then
    dies "cannot find the path specified." So the supported flow is:

      1. STAGE in build/src  — build.py --stage-only unpacks the cached Chromium
         source, applies the full DIG patch series, overlays DIG branding + embedded
         pages, and runs domain substitution. (Deep path is fine; no compile here.)
      2. MOVE build/src -> a short path (default C:\d). Same volume = instant rename.
      3. BUILD there         — build.py --build-only --source-tree <short> runs the
         rust-toolchain copy + gn gen + ninja, renames chrome.exe -> dig.exe, and
         stages the native dig_runtime.dll. No CI timeout, no installer packaging.

    The cached tarball lives in build/download_cache (chromium-<ver>-lite.tar.xz); if
    absent the first stage downloads it once, then every later build is fully offline.

    MODES:
      -Clean    Fresh, authoritative LATEST build: re-stage (step 1) + move (step 2) +
                build (step 3). Use the first time, after a `git pull` that changed any
                patch, or whenever the staged tree drifted. Full compile (hours).
      (default) Incremental: skip staging, just re-run step 3 against the existing
                short-path tree. Fast — only translation units touched since the last
                build recompile. Use after editing source directly in the short-path
                tree. (Patch-series changes require -Clean.)

.PARAMETER Clean
    Re-stage from the cached tarball and apply the current patch series before building.
    Required for the first build and after any patch/series change.

.PARAMETER Run
    Launch dig.exe when the build succeeds.

.PARAMETER BuildDir
    Short, MAX_PATH-safe path to stage the tree into and compile from. Default: C:\d.

.PARAMETER Jobs
    ninja -j parallelism. Default: let ninja pick (cores).

.EXAMPLE
    # First time / after pulling new patches — full latest build, then run it:
    pwsh scripts/build-local.ps1 -Clean -Run

.EXAMPLE
    # Iterating on a source edit made directly in C:\d — fast rebuild + run:
    pwsh scripts/build-local.ps1 -Run

.NOTES
    Prereqs (already on the dev box): Python 3.12+, Visual Studio 2022 with the C++
    workload incl. the ATL component, the Windows SDK, and Rust/cargo (for dig_runtime.dll;
    optional — the browser still builds without it). A clean build needs ~90 GB free.
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Run,
    [string]$BuildDir = 'C:\d',
    [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'

# Repo root = modules/dig-browser (this script lives in scripts/ under it).
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SrcTree  = Join-Path $RepoRoot 'build\src'
$OutDir   = Join-Path $BuildDir 'out\Default'
$DigExe   = Join-Path $OutDir   'dig.exe'

Write-Host "DIG Browser local build" -ForegroundColor Cyan
Write-Host "  repo  : $RepoRoot"
Write-Host "  stage : $SrcTree"
Write-Host "  build : $BuildDir  (short path, MAX_PATH-safe)"

# --- Prerequisite checks (fail fast with an actionable message) ---------------
$python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $python) { throw "python not found on PATH. Install Python 3.12+ (the build driver)." }

$installerDir = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer"
$vswhere = Join-Path $installerDir 'vswhere.exe'
if (-not (Test-Path $vswhere)) {
    throw "Visual Studio Installer (vswhere.exe) not found. Install VS 2022 with the 'Desktop development with C++' workload (incl. the VC.ATL component)."
}
$vsPath = & $vswhere -products * -prerelease -latest -property installationPath
if (-not $vsPath -or -not (Test-Path (Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'))) {
    throw "vcvars64.bat not found under '$vsPath'. Install the VS 2022 C++ workload."
}
Write-Host "  msvc  : $vsPath"

# Put the VS Installer dir (holds vswhere.exe) on PATH BEFORE build.py calls vcvars64.
# Without it, a late post-link step (generate_resource_allowlist -> undname) dies with
# "FileNotFoundError: [WinError 2]" near the end of an otherwise-successful build.
if (($env:PATH -split ';') -notcontains $installerDir) {
    $env:PATH = "$installerDir;$env:PATH"
}

# --- Disk guard ---------------------------------------------------------------
$drive = (Split-Path -Qualifier $BuildDir).TrimEnd(':')
$freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
Write-Host "  disk  : ${freeGB} GB free on ${drive}:"
if ($Clean -and $freeGB -lt 90) {
    Write-Warning "A clean full build wants ~90 GB free; only ${freeGB} GB available on ${drive}:. It may run out mid-link — free space first."
}

$buildArgs = @('-j', "$Jobs")  # placeholder; rebuilt per call below
$pyExtra = @()
if ($Jobs -gt 0) { $pyExtra = @('-j', "$Jobs") }

Push-Location $RepoRoot
try {
    if ($Clean) {
        # --- Step 1: stage the latest patch series into build/src ----------------
        if (Test-Path $SrcTree) {
            Write-Host "[1/3] Removing stale staged tree (so the full current patch series re-applies)..." -ForegroundColor Yellow
            Remove-Item -Recurse -Force $SrcTree
        }
        Write-Host "[1/3] Staging: python build.py --tarball --stage-only" -ForegroundColor Cyan
        & python build.py --tarball --stage-only
        if ($LASTEXITCODE -ne 0) { throw "Staging (build.py --stage-only) failed with code $LASTEXITCODE" }
        if (-not (Test-Path (Join-Path $SrcTree 'BUILD.gn'))) { throw "Staging produced no $SrcTree\BUILD.gn." }

        # --- Step 2: move the staged tree to the short, MAX_PATH-safe path -------
        if (Test-Path $BuildDir) {
            Write-Host "[2/3] Removing previous build tree at $BuildDir..." -ForegroundColor Yellow
            Remove-Item -Recurse -Force $BuildDir
        }
        Write-Host "[2/3] Moving $SrcTree -> $BuildDir" -ForegroundColor Cyan
        Move-Item -Path $SrcTree -Destination $BuildDir
    } else {
        if (-not (Test-Path (Join-Path $BuildDir 'BUILD.gn'))) {
            throw "No staged tree at $BuildDir. Run with -Clean first to stage + move + build the latest patch series."
        }
        Write-Host "[*] Incremental build against existing tree at $BuildDir" -ForegroundColor Cyan
    }

    # --- Step 3: compile the short-path tree ------------------------------------
    Write-Host "[3/3] Building: python build.py --build-only --source-tree `"$BuildDir`" $($pyExtra -join ' ')" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & python build.py --build-only --source-tree "$BuildDir" @pyExtra
    if ($LASTEXITCODE -ne 0) { throw "build.py --build-only failed with code $LASTEXITCODE" }
    $sw.Stop()
    Write-Host ("Build finished in {0:hh\:mm\:ss}." -f $sw.Elapsed) -ForegroundColor Green
} finally {
    Pop-Location
}

if (-not (Test-Path $DigExe)) {
    throw "Build reported success but $DigExe is missing — check the ninja/link output above."
}
Write-Host "dig.exe: $DigExe" -ForegroundColor Green

# --- Launch -------------------------------------------------------------------
if ($Run) {
    Write-Host "Launching DIG Browser..." -ForegroundColor Cyan
    Start-Process -FilePath $DigExe
}
