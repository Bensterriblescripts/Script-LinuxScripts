#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
GHOSTTY_SHA = '51d8bd87e95c58c7e17ac765a9a88121b2cd3b63dc57b6dd3e0d9495e16a471c'
ZIG_SHA = '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00'
GHOSTTY_VERSION = '1.3.2+nightly20260913T1630+windowrouting1'
CONFIG_FILES = (
    '.pi/agent/settings.json', '.pi/agent/keybindings.json', '.pi/agent/AGENTS.md',
    '.pi/agent/pi-blackhole/pi-blackhole-config.json',
    '.pi/agent/local/pi-build/index.ts', '.pi/agent/local/pi-build/workflow.ts',
    '.pi/agent/local/pi-build/file-context.ts', '.pi/agent/local/pi-build/clipboard-images.ts',
    '.pi/agent/local/pi-build/package.json', '.pi/agent/local/pi-build/LICENSE',
    '.pi/agent/extensions/codex-weekly/index.ts', '.pi/agent/extensions/codex-weekly/status.ts',
    '.pi/agent/extensions/clipboard-image-preview/index.ts',
    '.pi/agent/extensions/global-input-history/index.ts',
    '.pi/agent/extensions/global-input-history/storage.mjs',
    '.pi/agent/extensions/global-input-history/writer.mjs',
    '.pi/agent/extensions/ghostty-status/index.ts',
    '.config/ghostty/config.ghostty', '.config/ghostty/auto/theme.ghostty',
    '.config/nvim/init.lua', '.config/nvim/nvim-pack-lock.json',
    '.config/fish/config.fish', '.local/bin/dolphin-open-ghostty',
    '.local/share/kio/servicemenus/open-pi.desktop',
    '.local/share/kio/servicemenus/open-nvim.desktop',
    '.local/share/kio/servicemenus/com.mitchellh.ghostty.desktop',
)


def fail(message):
    raise RuntimeError(message)


def run(args, cwd=None, env=None, capture=False):
    return subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def need(*names):
    missing = [name for name in names if not shutil.which(name)]
    if missing:
        fail('Install prerequisites with your distribution package manager, then retry: ' + ', '.join(missing))


def exists(path):
    return path.exists() or path.is_symlink()


def safe_parent(path):
    for parent in path.parents:
        if parent.is_symlink():
            fail(f'Refusing symlinked parent: {parent}')
        if parent.exists() and not parent.is_dir():
            fail(f'Parent is not a directory: {parent}')


def preflight(paths, allowed, flag):
    for path in paths:
        safe_parent(path)
    conflicts = [str(p) for p in paths if exists(p)]
    if conflicts and not allowed:
        fail(f'Existing targets; inspect/back up and pass {flag} to replace them:\n' + '\n'.join(conflicts))


def fetch(source, destination, digest, algorithm='sha256'):
    if source.startswith('https://'):
        with urllib.request.urlopen(source, timeout=120) as response, destination.open('wb') as out:
            shutil.copyfileobj(response, out)
    elif '://' in source:
        fail('Only HTTPS downloads or local archive paths are supported')
    else:
        shutil.copyfile(Path(source).expanduser(), destination)
    actual = hashlib.new(algorithm, destination.read_bytes()).digest()
    expected = base64.b64decode(digest) if algorithm == 'sha512' else bytes.fromhex(digest)
    if actual != expected:
        fail(f'Integrity mismatch for {source}; no fallback version will be used')


def unpack(archive, destination):
    destination.mkdir()
    with tarfile.open(archive) as source:
        members = [m for m in source.getmembers()
                   if not any(p == '.git' or p.startswith('.git') for p in Path(m.name).parts)]
        source.extractall(destination, members=members, filter='data')
    children = list(destination.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        fail(f'Expected one archive root in {archive}')
    return children[0]


def patch(source, path):
    args = ['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-i', path]
    run(args + ['--dry-run'], cwd=source)
    run(args, cwd=source)


def replace_tree(source, target, allowed):
    preflight([target], allowed, '--replace-install')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pi-install-', dir=target.parent) as temp:
        incoming = Path(temp) / 'incoming'
        backup = Path(temp) / 'previous'
        shutil.copytree(source, incoming, symlinks=True)
        if exists(target):
            target.rename(backup)
        try:
            incoming.rename(target)
        except BaseException:
            if exists(backup):
                backup.rename(target)
            raise


def render_desktop(content, home):
    if '%' in str(home) or any(ord(c) < 32 for c in str(home)):
        fail('Desktop launcher target home must not contain percent signs or control characters')
    executable = str(home / '.local/bin/dolphin-open-ghostty')
    executable = ''.join('\\' + c if c in '\\"`$' else c for c in executable)
    executable = executable.replace('\\', '\\\\')
    return content.replace('Exec=dolphin-open-ghostty ', f'Exec="{executable}" ')


def deploy(args):
    home = Path(os.path.abspath(Path(args.home).expanduser()))
    targets = [home / name for name in CONFIG_FILES]
    preflight(targets, args.overwrite_config, '--overwrite-config')
    for name, target in zip(CONFIG_FILES, targets):
        source = ROOT / name
        if source.is_symlink() or not source.is_file():
            fail(f'Missing regular config source: {source}')
        if target.is_dir() and not target.is_symlink():
            fail(f'Refusing to replace directory with a config file: {target}')
        if name.endswith('.desktop'):
            render_desktop(source.read_text(), home)
    if args.dry_run:
        print('\n'.join(str(p) for p in targets))
        return
    with tempfile.TemporaryDirectory(prefix='portable-config-') as temp:
        staged = Path(temp)
        for name in CONFIG_FILES:
            destination = staged / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = (ROOT / name).read_text()
            if name.endswith('.desktop'):
                content = render_desktop(content, home)
            destination.write_text(content)
            destination.chmod(0o755 if name == '.local/bin/dolphin-open-ghostty' else 0o644)
        preflight(targets, args.overwrite_config, '--overwrite-config')
        for name, target in zip(CONFIG_FILES, targets):
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.config-install-', dir=target.parent)
            os.close(fd)
            try:
                shutil.copyfile(staged / name, temporary)
                os.chmod(temporary, (staged / name).stat().st_mode & 0o777)
                if args.overwrite_config:
                    os.replace(temporary, target)
                else:
                    os.link(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    print('Config deployed. Runtime prerequisites: fish, system Python with PyGObject, busctl, flock; codex-weekly also needs ~/.local/bin/codex. Ensure ~/.local/bin is on PATH and authenticate Pi separately. No state was copied.')


def pin_dependencies(source):
    lock_path = source / 'npm-shrinkwrap.json'
    lock = json.loads(lock_path.read_text())
    pins = json.loads((ROOT / '.local/share/pi-customisations/dependency-integrities.json').read_text())
    missing = {name for name, item in lock['packages'].items() if name and not item.get('integrity')}
    if missing != set(pins):
        fail('Pi dependency integrity overrides do not match the pinned lockfile')
    for name, pin in pins.items():
        item = lock['packages'][name]
        if item.get('resolved') != pin['resolved']:
            fail(f'Pi dependency URL mismatch: {name}')
        item['integrity'] = pin['integrity']
    lock_path.write_text(json.dumps(lock, indent=2) + '\n')


def pi(args, work):
    need('node', 'npm', 'patch')
    version = run(['node', '--version'], capture=True).strip().lstrip('v')
    if tuple(map(int, version.split('.'))) < (22, 19, 0):
        fail('Pi requires Node >=22.19.0')
    manifest = json.loads((ROOT / '.local/share/pi-customisations/manifest.json').read_text())
    package = next(p for p in manifest['packages'] if p['name'] == '@earendil-works/pi-coding-agent')
    baseline = package['baseline']
    archive = work / 'pi.tgz'
    fetch(baseline['tarballUrl'], archive, baseline['integrity'].removeprefix('sha512-'), 'sha512')
    source = unpack(archive, work / 'pi')
    patch_path = ROOT / '.local/share/pi-customisations' / package['patch']['file']
    if hashlib.sha256(patch_path.read_bytes()).hexdigest() != package['patch']['sha256']:
        fail('Pi patch checksum mismatch')
    patch(source, patch_path)
    for item in package['affectedFiles']:
        if item['action'] == 'mode':
            continue
        path = source / item['path']
        if hashlib.sha256(path.read_bytes()).hexdigest() != item['custom']['sha256']:
            fail(f'Patched Pi payload mismatch: {path}')
    if not (source / 'npm-shrinkwrap.json').is_file():
        fail('Pinned Pi release is missing npm-shrinkwrap.json')
    pin_dependencies(source)
    env = dict(os.environ, npm_config_cache=str(work / 'npm-cache'), npm_config_engine_strict='true')
    run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=source, env=env)
    cli = source / 'dist/bundle/cli.js'
    cli.chmod(0o755)
    run(['node', '--check', cli])
    if not args.install:
        shutil.copytree(source, Path(args.output) / 'pi', symlinks=True)
        return
    home = Path(os.path.abspath(Path(args.home).expanduser()))
    target = home / '.local/lib/node_modules/@earendil-works/pi-coding-agent'
    link = home / '.local/bin/pi'
    preflight([target, link], args.replace_install, '--replace-install')
    if link.is_dir() and not link.is_symlink():
        fail(f'Refusing CLI directory: {link}')
    replace_tree(source, target, args.replace_install)
    link.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pi-link-', dir=link.parent) as temp:
        staged = Path(temp) / 'pi'
        staged.symlink_to(os.path.relpath(target / 'dist/bundle/cli.js', link.parent))
        if args.replace_install:
            staged.replace(link)
        else:
            link.symlink_to(os.readlink(staged))
    print(f'Installed patched Pi 0.87.1: {link}. Config deployment is a separate command.')


def ghostty(args, work):
    need('pkg-config', 'patch', 'dpkg-deb', 'dpkg-shlibdeps', 'cc')
    if platform.machine() != 'x86_64':
        fail('Pinned Zig archive and Ghostty package support Linux x86_64 only')
    if not Path('/etc/debian_version').exists():
        fail('Ghostty packaging supports Debian-family Linux only; no other package manager will be invoked')
    if not args.ghostty_source:
        fail('Pass --ghostty-source PATH_OR_HTTPS_URL for ghostty-1.3.2-main-+7aab0a0 source archive, SHA256 ' + GHOSTTY_SHA)
    for dependency in ['gtk4', 'libadwaita-1']:
        try:
            run(['pkg-config', '--exists', dependency])
        except subprocess.CalledProcessError:
            fail(f'Missing development prerequisite {dependency}; install it with your distribution package manager')
    archive = work / 'ghostty.tar.gz'
    fetch(args.ghostty_source, archive, GHOSTTY_SHA)
    source = unpack(archive, work / 'ghostty')
    zig_archive = work / 'zig.tar.xz'
    fetch(args.zig_source, zig_archive, ZIG_SHA)
    zig_root = unpack(zig_archive, work / 'zig')
    zig = zig_root / 'zig'
    if run([zig, 'version'], capture=True).strip() != '0.16.0':
        fail('Expected Zig 0.16.0')
    patch(source, ROOT / '.local/share/ghostty-window-routing/window-routing.patch')
    stage = work / 'package'
    stage.mkdir()
    env = dict(os.environ, DESTDIR=str(stage), ZIG_GLOBAL_CACHE_DIR=str(work / 'zig-cache'))
    run([zig, 'build', '-Doptimize=ReleaseFast', '-Dversion-string=1.3.2-dev+20260913.window-routing1',
         '-Dlib-version-string=0.1.0-dev', '-Demit-docs=false', '--prefix', '/usr', f'-j{args.jobs}'], cwd=source, env=env)
    if not (stage / 'usr/bin/ghostty').is_file():
        fail('Ghostty build did not produce usr/bin/ghostty')
    copyright_path = stage / 'usr/share/doc/ghostty/copyright'
    copyright_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'LICENSE', copyright_path)
    control = 'Source: ghostty\nSection: x11\nPriority: optional\nMaintainer: Local Build <root@localhost>\n\nPackage: ghostty\nArchitecture: amd64\nDescription: Ghostty with window routing\n'
    (work / 'debian').mkdir()
    (work / 'debian/control').write_text(control)
    binaries = []
    for path in (stage / 'usr').rglob('*'):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                if stream.read(4) == b'\x7fELF':
                    binaries.append(path)
    dependencies = run(['dpkg-shlibdeps', '-O', f'-l{stage / "usr/lib"}',
                        *[f'-e{path}' for path in binaries]], cwd=work, capture=True).strip()
    if not dependencies.startswith('shlibs:Depends=') or '\n' in dependencies:
        fail('Could not determine Ghostty runtime dependencies')
    (stage / 'DEBIAN').mkdir()
    (stage / 'DEBIAN/control').write_text(
        f'Package: ghostty\nVersion: {GHOSTTY_VERSION}\nArchitecture: amd64\n'
        f'Maintainer: Local Build <root@localhost>\nDepends: {dependencies.split("=", 1)[1]}\n'
        'Description: Ghostty with window-level Dolphin routing\n')
    package = work / f'ghostty_{GHOSTTY_VERSION}_amd64.deb'
    run(['dpkg-deb', '--root-owner-group', '--build', stage, package])
    if args.install:
        if not args.allow_sudo:
            fail('Ghostty installation requires --allow-sudo; use --output DIRECTORY for build-only')
        run(['sudo', 'dpkg', '-i', package])
        print('Ghostty installed. Restart existing Ghostty windows when convenient. Config deployment is separate.')
    else:
        shutil.copyfile(package, Path(args.output) / package.name)


def main():
    parser = argparse.ArgumentParser(description='Portable config deployment and pinned Pi/Ghostty builds; no automatic prerequisite installation.')
    parser.add_argument('action', choices=['deploy', 'pi', 'ghostty'])
    parser.add_argument('--home', default=str(Path.home()), help='Target home for deploy or Pi installation')
    parser.add_argument('--overwrite-config', action='store_true', help='Explicitly allow replacement of existing managed user config files')
    parser.add_argument('--replace-install', action='store_true', help='Allow replacement of existing Pi application and CLI link (not config)')
    parser.add_argument('--install', action='store_true', help='Install application instead of exporting build output; does not deploy config')
    parser.add_argument('--allow-sudo', action='store_true', help='Authorize sudo dpkg -i for Ghostty only')
    parser.add_argument('--output', help='New, nonexisting build output directory outside this config tree; required without --install')
    parser.add_argument('--ghostty-source', help='Local path or HTTPS URL for the pinned 7aab0a0 Ghostty release archive; hash is enforced')
    parser.add_argument('--zig-source', default='https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz', help='Pinned Zig archive URL or local path')
    parser.add_argument('--jobs', type=int, default=2)
    parser.add_argument('--dry-run', action='store_true', help='Check destinations/gates only; no download, build, install or deployment')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        fail('Python >=3.12 is required for safe archive extraction')
    if platform.system() != 'Linux':
        fail('Only Linux is supported')
    if args.jobs < 1:
        fail('--jobs must be positive')
    if args.action == 'deploy':
        if args.install or args.output or args.allow_sudo or args.replace_install:
            fail('deploy accepts --home, --overwrite-config and --dry-run; application options are separate')
        deploy(args)
        return
    if args.overwrite_config:
        fail('--overwrite-config applies only to deploy; application builds never deploy config')
    if args.install and args.output:
        fail('Choose --install or --output, not both')
    if args.action == 'ghostty' and args.install and not args.allow_sudo:
        fail('Refusing privileged installation without --allow-sudo; use --output DIRECTORY for build-only')
    if args.action == 'pi' and args.install:
        home = Path(os.path.abspath(Path(args.home).expanduser()))
        preflight([home / '.local/lib/node_modules/@earendil-works/pi-coding-agent', home / '.local/bin/pi'], args.replace_install, '--replace-install')
        link = home / '.local/bin/pi'
        if link.is_dir() and not link.is_symlink():
            fail(f'Refusing CLI directory: {link}')
    output = None
    if not args.install:
        if not args.output:
            fail('Build-only requires --output NEW_DIRECTORY; use --install to install instead')
        output = Path(os.path.abspath(Path(args.output).expanduser()))
        if output.resolve().is_relative_to(ROOT.parent):
            fail('Build outputs must be outside the repository config tree')
        preflight([output], False, 'a different --output directory')
        args.output = str(output)
    if args.action == 'ghostty' and args.install:
        need('sudo', 'dpkg')
    if args.dry_run:
        print(f'Preflight passed for {args.action}; no actions performed. Build prerequisites and network are not checked.')
        return
    if output:
        output.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory(prefix='portable-build-') as temporary:
            work = Path(temporary)
            if args.action == 'pi':
                pi(args, work)
            else:
                ghostty(args, work)
    except BaseException:
        if output and output.exists():
            shutil.rmtree(output)
        raise


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
