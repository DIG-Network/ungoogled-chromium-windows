#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# Copyright (c) 2019 The ungoogled-chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.
"""
ungoogled-chromium build script for Microsoft Windows
"""

import sys
import time
import argparse
import os
import re
import shutil
import subprocess
import ctypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'ungoogled-chromium' / 'utils'))
import downloads
import domain_substitution
import prune_binaries
import patches
from _common import ENCODING, USE_REGISTRY, ExtractorEnum, get_logger
sys.path.pop(0)

_ROOT_DIR = Path(__file__).resolve().parent
_PATCH_BIN_RELPATH = Path('third_party/git/usr/bin/patch.exe')


def _apply_dig_branding(source_tree):
    """Overlay the DIG Browser binary brand assets onto the Chromium tree.

    Binary assets (PNG icons, the Windows .ico, the branded new-tab page) are
    awkward to ship as text quilt patches, so the harness copies them straight
    over the corresponding Chromium theme/resource files AFTER patches are
    applied. The accompanying string/theme changes live in the
    windows-dig-branding.patch / windows-dig-newtab.patch quilt patches; this
    step only swaps files in place. Idempotent and best-effort: a missing
    target (e.g. on a Chromium rebase that renamed an icon) is logged and
    skipped rather than failing the build.
    """
    branding_dir = _ROOT_DIR / 'dig' / 'branding'
    if not branding_dir.exists():
        get_logger().warning('DIG branding assets not found at %s; skipping', branding_dir)
        return

    theme = source_tree / 'chrome' / 'app' / 'theme' / 'chromium'

    # Product-logo PNGs used across the UI (About box, app icon, etc.).
    logo_map = {
        'product_logo_16.png': 'product_logo_16.png',
        'product_logo_24.png': 'product_logo_24.png',
        'product_logo_32.png': 'product_logo_32.png',
        'product_logo_48.png': 'product_logo_48.png',
        'product_logo_64.png': 'product_logo_64.png',
        'product_logo_128.png': 'product_logo_128.png',
        'product_logo_256.png': 'product_logo_256.png',
    }
    for src_name, dst_name in logo_map.items():
        src = branding_dir / src_name
        dst = theme / dst_name
        if src.exists() and dst.parent.exists():
            shutil.copy2(src, dst)
            get_logger().info('DIG branding: %s', dst_name)
        else:
            get_logger().warning('DIG branding: skip %s (missing src or dst dir)', dst_name)

    # The toolbar home button (the DIG coin, IDR_PRODUCT_LOGO_16) and several
    # other UI surfaces load product_logo_16/32 through the chrome_scaled_image
    # pak, which reads from the per-scale theme dirs (default_100_percent /
    # default_200_percent), NOT chrome/app/theme/chromium. If we only overlay
    # the latter, the home button falls back to the stock Chromium logo. Copy
    # the DIG coin into both scale dirs too.
    for scale in ('default_100_percent', 'default_200_percent'):
        scale_theme = source_tree / 'chrome' / 'app' / 'theme' / scale / 'chromium'
        for name in ('product_logo_16.png', 'product_logo_32.png'):
            src = branding_dir / name
            dst = scale_theme / name
            if src.exists() and dst.parent.exists():
                shutil.copy2(src, dst)
                get_logger().info('DIG branding: %s/%s', scale, name)
            else:
                get_logger().warning(
                    'DIG branding: skip %s/%s (missing src or dst dir)', scale, name)

    # Windows executable / taskbar icon. Chromium reads this multi-resolution
    # .ico for chrome.exe (chrome/app/chrome_exe.ver / chrome_dll.rc).
    ico_src = branding_dir / 'chrome.ico'
    for ico_dst in [
        theme / 'win' / 'tiles' / 'Logo.png',  # may not exist on all branches
        theme / 'win' / 'chromium.ico',
        source_tree / 'chrome' / 'app' / 'theme' / 'chromium' / 'win' / 'chrome.ico',
    ]:
        if ico_dst.suffix == '.ico' and ico_src.exists() and ico_dst.parent.exists():
            shutil.copy2(ico_src, ico_dst)
            get_logger().info('DIG branding: %s', ico_dst.name)

    # Branded new-tab / start page asset, copied next to the NTP resources so
    # the windows-dig-newtab.patch can reference it. Best-effort.
    newtab_src = _ROOT_DIR / 'dig' / 'newtab' / 'dig_newtab.html'
    if newtab_src.exists():
        dst_dir = source_tree / 'chrome' / 'browser' / 'resources' / 'dig'
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(newtab_src, dst_dir / 'dig_newtab.html')
        logo256 = branding_dir / 'dig_logo_256.png'
        if logo256.exists():
            shutil.copy2(logo256, dst_dir / 'dig_logo_256.png')
        get_logger().info('DIG branding: new-tab page installed')

    # Rebrand the user-visible product/company strings in chromium_strings.grd.
    # Done as a tolerant text substitution (rather than a line-anchored quilt
    # hunk) so it survives Chromium rebases that move these <message> elements.
    grd = source_tree / 'chrome' / 'app' / 'chromium_strings.grd'
    if grd.exists():
        try:
            text = grd.read_text(encoding=ENCODING)
            subs = [
                ('name="IDS_PRODUCT_NAME"', 'Chromium', 'DIG Browser'),
                ('name="IDS_SHORTCUT_NAME"', 'Chromium', 'DIG Browser'),
                ('name="IDS_ABOUT_VERSION_COMPANY_NAME"',
                 'The Chromium Authors', 'DIG Network'),
            ]
            changed = False
            for anchor, old, new in subs:
                # Replace `>old<` only within the message element that carries
                # `anchor`, so we don't touch unrelated occurrences.
                idx = text.find(anchor)
                if idx == -1:
                    get_logger().warning('DIG branding: grd anchor not found: %s', anchor)
                    continue
                end = text.find('</message>', idx)
                if end == -1:
                    continue
                segment = text[idx:end]
                needle = '>' + old + '<'
                if needle in segment:
                    segment = segment.replace(needle, '>' + new + '<', 1)
                    text = text[:idx] + segment + text[end:]
                    changed = True
            if changed:
                grd.write_text(text, encoding=ENCODING)
                get_logger().info('DIG branding: rebranded chromium_strings.grd')
        except Exception as exc:  # best-effort, never fail the build on this
            get_logger().warning('DIG branding: grd substitution skipped (%s)', exc)


def _get_vcvars_path(name='64'):
    """
    Returns the path to the corresponding vcvars*.bat path

    As of VS 2017, name can be one of: 32, 64, all, amd64_x86, x86_amd64
    """
    vswhere_exe = '%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    result = subprocess.run(
        '"{}" -products * -prerelease -latest -property installationPath'.format(vswhere_exe),
        shell=True,
        check=True,
        stdout=subprocess.PIPE,
        universal_newlines=True)
    vcvars_path = Path(result.stdout.strip(), 'VC/Auxiliary/Build/vcvars{}.bat'.format(name))
    if not vcvars_path.exists():
        raise RuntimeError(
            'Could not find vcvars batch script in expected location: {}'.format(vcvars_path))
    return vcvars_path


def _run_build_process(*args, **kwargs):
    """
    Runs the subprocess with the correct environment variables for building
    """
    # Add call to set VC variables
    cmd_input = ['call "%s" >nul' % _get_vcvars_path()]
    cmd_input.append('set DEPOT_TOOLS_WIN_TOOLCHAIN=0')
    cmd_input.append(' '.join(map('"{}"'.format, args)))
    cmd_input.append('exit\n')
    subprocess.run(('cmd.exe', '/k'),
                   input='\n'.join(cmd_input),
                   check=True,
                   encoding=ENCODING,
                   **kwargs)


def _run_build_process_timeout(*args, timeout):
    """
    Runs the subprocess with the correct environment variables for building
    """
    # Add call to set VC variables
    cmd_input = ['call "%s" >nul' % _get_vcvars_path()]
    cmd_input.append('set DEPOT_TOOLS_WIN_TOOLCHAIN=0')
    cmd_input.append(' '.join(map('"{}"'.format, args)))
    cmd_input.append('exit\n')
    with subprocess.Popen(('cmd.exe', '/k'), encoding=ENCODING, stdin=subprocess.PIPE, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP) as proc:
        proc.stdin.write('\n'.join(cmd_input))
        proc.stdin.close()
        try:
            proc.wait(timeout)
            if proc.returncode != 0:
                raise RuntimeError('Build failed!')
        except subprocess.TimeoutExpired:
            print('Sending keyboard interrupt')
            for _ in range(3):
                ctypes.windll.kernel32.GenerateConsoleCtrlEvent(1, proc.pid)
                time.sleep(1)
            try:
                proc.wait(10)
            except:
                proc.kill()
            raise KeyboardInterrupt


def _make_tmp_paths():
    """Creates TMP and TEMP variable dirs so ninja won't fail"""
    tmp_path = Path(os.environ['TMP'])
    if not tmp_path.exists():
        tmp_path.mkdir()
    tmp_path = Path(os.environ['TEMP'])
    if not tmp_path.exists():
        tmp_path.mkdir()


def _stage_dig_runtime(out_dir):
    """Build + stage the native in-process DIG runtime DLL next to the browser.

    dig_runtime.dll is a cargo-built cdylib (the sibling `digstore` submodule's
    `dig-runtime` crate). The browser loads it at startup (chrome_browser_main's
    PostBrowserStart) and runs the DIG node — dig:// serving + chain-anchored
    root resolution — on its own threads INSIDE the browser process, so there is
    NO dig-node.exe sidecar. We build it from the sibling crate and copy it next
    to dig.exe. Best-effort: if cargo or the crate is unavailable the browser
    still builds (dig:// just won't serve until the DLL is present).
    """
    digstore = _ROOT_DIR.parent / 'digstore'
    if not (digstore / 'crates' / 'dig-runtime' / 'Cargo.toml').exists():
        get_logger().warning(
            'dig-runtime crate not found at %s; skipping DIG runtime DLL', digstore)
        return
    try:
        subprocess.run(['cargo', 'build', '-p', 'dig-runtime', '--release'],
                       cwd=str(digstore), check=True)
    except Exception as exc:  # noqa: BLE001 — best-effort packaging step
        get_logger().warning('dig-runtime build failed (%s); skipping DIG runtime DLL', exc)
        return
    dll = digstore / 'target' / 'release' / 'dig_runtime.dll'
    if dll.exists():
        shutil.copy2(dll, out_dir / 'dig_runtime.dll')
        get_logger().info('Staged native DIG runtime DLL: %s', out_dir / 'dig_runtime.dll')
    else:
        get_logger().warning('dig_runtime.dll missing at %s after build', dll)


def main():
    """CLI Entrypoint"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--disable-ssl-verification',
        action='store_true',
        help='Disables SSL verification for downloading')
    parser.add_argument(
        '--7z-path',
        dest='sevenz_path',
        default=USE_REGISTRY,
        help=('Command or path to 7-Zip\'s "7z" binary. If "_use_registry" is '
              'specified, determine the path from the registry. Default: %(default)s'))
    parser.add_argument(
        '--winrar-path',
        dest='winrar_path',
        default=USE_REGISTRY,
        help=('Command or path to WinRAR\'s "winrar.exe" binary. If "_use_registry" is '
              'specified, determine the path from the registry. Default: %(default)s'))
    parser.add_argument(
        '-j',
        type=int,
        dest='thread_count',
        help=('Number of CPU threads to use for compiling'))
    parser.add_argument(
        '--ci',
        action='store_true'
    )
    parser.add_argument(
        '--x86',
        action='store_true'
    )
    parser.add_argument(
        '--arm',
        action='store_true'
    )
    parser.add_argument(
        '--tarball',
        action='store_true'
    )
    args = parser.parse_args()

    # Set common variables
    source_tree = _ROOT_DIR / 'build' / 'src'
    downloads_cache = _ROOT_DIR / 'build' / 'download_cache'

    if not args.ci or not (source_tree / 'BUILD.gn').exists():
        # Setup environment
        source_tree.mkdir(parents=True, exist_ok=True)
        downloads_cache.mkdir(parents=True, exist_ok=True)
        _make_tmp_paths()

        # Extractors
        extractors = {
            ExtractorEnum.SEVENZIP: args.sevenz_path,
            ExtractorEnum.WINRAR: args.winrar_path,
        }

        # Prepare source folder
        if args.tarball:
            # Download chromium tarball
            get_logger().info('Downloading chromium tarball...')
            download_info = downloads.DownloadInfo([_ROOT_DIR / 'ungoogled-chromium' / 'downloads.ini'])
            downloads.retrieve_downloads(download_info, downloads_cache, None, True, args.disable_ssl_verification)
            try:
                downloads.check_downloads(download_info, downloads_cache, None)
            except downloads.HashMismatchError as exc:
                get_logger().error('File checksum does not match: %s', exc)
                exit(1)

            # Unpack chromium tarball
            get_logger().info('Unpacking chromium tarball...')
            downloads.unpack_downloads(download_info, downloads_cache, None, source_tree, extractors)
        else:
            # Clone sources
            subprocess.run([sys.executable, str(Path('ungoogled-chromium', 'utils', 'clone.py')), '-o', 'build\\src', '-p', 'win32' if args.x86 else 'win-arm64' if args.arm else 'win64'], check=True)

        # Retrieve windows downloads
        get_logger().info('Downloading required files...')
        download_info_win = downloads.DownloadInfo([_ROOT_DIR / 'downloads.ini'])
        downloads.retrieve_downloads(download_info_win, downloads_cache, None, True, args.disable_ssl_verification)
        try:
            downloads.check_downloads(download_info_win, downloads_cache, None)
        except downloads.HashMismatchError as exc:
            get_logger().error('File checksum does not match: %s', exc)
            exit(1)

        # Prune binaries
        pruning_list = (_ROOT_DIR / 'ungoogled-chromium' / 'pruning.list') if args.tarball else (_ROOT_DIR  / 'pruning.list')
        unremovable_files = prune_binaries.prune_files(
            source_tree,
            pruning_list.read_text(encoding=ENCODING).splitlines()
        )
        if unremovable_files:
            # The official `-lite` source tarball already omits some files that pruning.list
            # targets (build/test data, etc.). Those show up here as "unremovable" only because
            # they are already gone — not a real failure. Warn and continue rather than aborting
            # the whole build over already-absent files.
            get_logger().warning(
                'pruning.list entries already absent (expected for the -lite tarball), skipping: %s',
                unremovable_files)

        # Unpack downloads
        DIRECTX = source_tree / 'third_party' / 'microsoft_dxheaders' / 'src'
        ESBUILD = source_tree / 'third_party' / 'devtools-frontend' / 'src' / 'third_party' / 'esbuild'
        if DIRECTX.exists():
            shutil.rmtree(DIRECTX)
            DIRECTX.mkdir()
        if ESBUILD.exists():
            shutil.rmtree(ESBUILD)
            ESBUILD.mkdir()
        get_logger().info('Unpacking downloads...')
        downloads.unpack_downloads(download_info_win, downloads_cache, None, source_tree, extractors)

        # Apply patches
        # First, ungoogled-chromium-patches
        patches.apply_patches(
            patches.generate_patches_from_series(_ROOT_DIR / 'ungoogled-chromium' / 'patches', resolve=True),
            source_tree,
            patch_bin_path=(source_tree / _PATCH_BIN_RELPATH)
        )
        # Then Windows-specific patches
        patches.apply_patches(
            patches.generate_patches_from_series(_ROOT_DIR / 'patches', resolve=True),
            source_tree,
            patch_bin_path=(source_tree / _PATCH_BIN_RELPATH)
        )

        # Overlay DIG Browser binary brand assets (icons + new-tab page).
        get_logger().info('Applying DIG Browser branding assets...')
        _apply_dig_branding(source_tree)

        # Substitute domains
        domain_substitution_list = (_ROOT_DIR / 'ungoogled-chromium' / 'domain_substitution.list') if args.tarball else (_ROOT_DIR  / 'domain_substitution.list')
        domain_substitution.apply_substitution(
            _ROOT_DIR / 'ungoogled-chromium' / 'domain_regex.list',
            domain_substitution_list,
            source_tree,
            None
        )

    # Check if rust-toolchain folder has been populated
    HOST_CPU_IS_64BIT = sys.maxsize > 2**32
    RUST_DIR_DST = source_tree / 'third_party' / 'rust-toolchain'
    RUST_DIR_SRC64 = source_tree / 'third_party' / 'rust-toolchain-x64'
    RUST_DIR_SRC86 = source_tree / 'third_party' / 'rust-toolchain-x86'
    RUST_DIR_SRCARM = source_tree / 'third_party' / 'rust-toolchain-arm'
    RUST_FLAG_FILE = RUST_DIR_DST / 'INSTALLED_VERSION'
    if not args.ci or not RUST_FLAG_FILE.exists():
        # Directories to copy from source to target folder
        DIRS_TO_COPY = ['bin', 'lib']

        # Loop over all source folders
        for rust_dir_src in [RUST_DIR_SRC64, RUST_DIR_SRC86, RUST_DIR_SRCARM]:
            # Loop over all dirs to copy
            for dir_to_copy in DIRS_TO_COPY:
                # Copy bin folder for host architecture
                if (dir_to_copy == 'bin') and (HOST_CPU_IS_64BIT != (rust_dir_src == RUST_DIR_SRC64)):
                    continue

                # Create target dir
                target_dir = RUST_DIR_DST / dir_to_copy
                if not os.path.isdir(target_dir):
                    os.makedirs(target_dir)

                # Loop over all subfolders of the rust source dir
                for cp_src in rust_dir_src.glob(f'*/{dir_to_copy}/*'):
                    cp_dst = target_dir / cp_src.name
                    if cp_src.is_dir():
                        shutil.copytree(cp_src, cp_dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(cp_src, cp_dst)

        # Generate version file
        with open(RUST_FLAG_FILE, 'w') as f:
            subprocess.run([source_tree / 'third_party' / 'rust-toolchain-x64' / 'rustc' / 'bin' / 'rustc.exe', '--version'], stdout=f)

    if not args.ci or not (source_tree / 'out/Default').exists():
        # Output args.gn
        (source_tree / 'out/Default').mkdir(parents=True)
        gn_flags = (_ROOT_DIR / 'ungoogled-chromium' / 'flags.gn').read_text(encoding=ENCODING)
        gn_flags += '\n'
        windows_flags = (_ROOT_DIR / 'flags.windows.gn').read_text(encoding=ENCODING)
        if args.x86:
            windows_flags = windows_flags.replace('x64', 'x86')
        elif args.arm:
            windows_flags = windows_flags.replace('x64', 'arm64')
        if args.tarball:
            windows_flags += '\nchrome_pgo_phase=0\n'
        gn_flags += windows_flags
        (source_tree / 'out/Default/args.gn').write_text(gn_flags, encoding=ENCODING)

    # Enter source tree to run build commands
    os.chdir(source_tree)

    if not args.ci or not os.path.exists('out\\Default\\gn.exe'):
        # Run GN bootstrap
        _run_build_process(
            sys.executable, 'tools\\gn\\bootstrap\\bootstrap.py', '-o', 'out\\Default\\gn.exe',
            '--skip-generate-buildfiles')

        # Run gn gen
        _run_build_process('out\\Default\\gn.exe', 'gen', 'out\\Default', '--fail-on-unused-args')

    if not args.ci or not os.path.exists('third_party\\rust-toolchain\\bin\\bindgen.exe'):
        # Build bindgen
        _run_build_process(
            sys.executable,
            'tools\\rust\\build_bindgen.py', '--skip-test')

    # Ninja commandline
    ninja_commandline = ['third_party\\ninja\\ninja.exe']
    if args.thread_count is not None:
        ninja_commandline.append('-j')
        ninja_commandline.append(args.thread_count)
    ninja_commandline.append('-C')
    ninja_commandline.append('out\\Default')
    ninja_commandline.append('chrome')
    ninja_commandline.append('chromedriver')
    ninja_commandline.append('mini_installer')

    # Run ninja
    if args.ci:
        _run_build_process_timeout(*ninja_commandline, timeout=3.5*60*60)
        # package
        os.chdir(_ROOT_DIR)
        subprocess.run([sys.executable, 'package.py', '--cpu-arch', '32bit' if args.x86 else 'arm' if args.arm else '64bit'])
    else:
        _run_build_process(*ninja_commandline)

    # Rename the built browser executable to the DIG Browser name. The
    # kBrowserProcessExecutable{Name,Path} constants are patched to "dig.exe"
    # (windows-dig-exe-name.patch), so the binary already expects this name;
    # here we make the on-disk artifact agree. chrome.dll is loaded by its own
    # literal name and is unaffected by the rename.
    out_dir = source_tree / 'out' / 'Default'
    built_exe = out_dir / 'chrome.exe'
    dig_exe = out_dir / 'dig.exe'
    if built_exe.exists():
        if dig_exe.exists():
            dig_exe.unlink()
        built_exe.rename(dig_exe)
        get_logger().info('Renamed browser executable to %s', dig_exe)

    # Stage the native in-process DIG runtime DLL beside dig.exe (no sidecar).
    _stage_dig_runtime(out_dir)


if __name__ == '__main__':
    main()
