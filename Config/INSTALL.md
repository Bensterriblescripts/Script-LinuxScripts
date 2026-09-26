# Restore this Linux configuration

Run commands from this `Config` directory on Linux with Python >= 3.12. Review `python3 setup.py --help` first. No application build or install implicitly deploys configuration. Install system dependencies with your distribution package manager; `setup.py` does not install prerequisites for you.

## Deploy configuration

```sh
python3 setup.py deploy --dry-run --home "$HOME"
python3 setup.py deploy --dry-run --home "$HOME" --overwrite-config
python3 setup.py deploy --home "$HOME" --overwrite-config
```

The first command refuses existing managed targets. Inspect/back up each listed target before using `--overwrite-config`; omit that flag for a fresh home with no conflicts. Dry-run checks destination gates and prints paths but does not write them. Deployment installs Pi agent settings and source extensions, Ghostty/Fish config, Dolphin service menus and helper, and Neovim config and plugin lockfile. It does not install Pi, Ghostty, Neovim, plugins, SSH credentials, authentication, sessions or caches. Do not restore `dolphinrc` from this backup.

## Patched Pi

Install Node >= 22.19.0, npm and `patch`. The pinned upstream Pi 0.87.1 archive, patch and dependency integrity overrides are used by `setup.py`; building downloads packages. Choose a **new** output directory outside this repository for a build-only export:

```sh
python3 setup.py pi --output "$HOME/pi-build-output" --dry-run
python3 setup.py pi --output "$HOME/pi-build-output"
```

Or explicitly install to `~/.local/lib/node_modules/@earendil-works/pi-coding-agent` with launcher `~/.local/bin/pi`:

```sh
python3 setup.py pi --install --home "$HOME" --replace-install
```

Omit `--replace-install` when neither target exists; otherwise inspect/back up the existing installation first. Deploy agent configuration independently with `setup.py deploy`, then authenticate Pi separately. Ensure `~/.local/bin` is on PATH; configured web-search support and optional extensions may need their own runtime prerequisites.

## Patched Ghostty

On Debian-family Linux amd64, install build dependencies including `pkg-config`, `patch`, `dpkg-deb`, `dpkg-shlibdeps`, `cc`, GTK4 and libadwaita-1 development files; build uses pinned Zig 0.16.0 (downloaded by default or supplied with `--zig-source PATH_OR_HTTPS_URL`). Supply the pinned Ghostty 1.3.2 source archive (`ghostty-1.3.2-main-+7aab0a0`) as a local path or HTTPS URL. `setup.py` checks its SHA256 and applies the stored window-routing patch; no fallback version is used.

```sh
python3 setup.py ghostty --ghostty-source /path/to/ghostty.tar.gz --output "$HOME/ghostty-build-output" --dry-run
python3 setup.py ghostty --ghostty-source /path/to/ghostty.tar.gz --output "$HOME/ghostty-build-output"
```

The second command builds a `.deb` into a **new** output directory outside the repository; it does not install it. To build and install instead:

```sh
python3 setup.py ghostty --ghostty-source /path/to/ghostty.tar.gz --install --allow-sudo
```

`--allow-sudo` authorizes `sudo dpkg -i` and may request a password; omit it to refuse privileged installation. Dry-run checks gates, not build prerequisites, archives or network. The package installs `/usr/bin/ghostty`, not a copy of a live local binary; restart old Ghostty windows after installation. Deploy the separate Ghostty config with `setup.py deploy` when ready. The Dolphin helper requires patched Ghostty's WindowRouting1 interface, system Python with PyGObject, `busctl`, and `/usr/bin/env`; the configured Ghostty shell is fish.

## Dolphin and Neovim

Deploy the helper and directory context menus together. The deployer rewrites each menu's `Exec=dolphin-open-ghostty ... %f` to the absolute helper path under the chosen `--home`; `%f` passes one selected directory, including paths with spaces. Refresh KDE service menus (for example, run `kbuildsycoca6 --noincremental` if available, then restart Dolphin). Right-click a directory and verify **Open Pi**, **Open Terminal**, and **Open in Neovim**. The helper uses `~/.local/bin/pi`, `/usr/bin/ghostty`, and `/usr/bin/nvim`; Pi and Neovim start in the selected directory.

Install Neovim >= 0.12 with `vim.pack` support (the source was used on 0.12.5). On first launch, allow network access for Neovim to acquire `nvim-tree.lua` at the revision pinned in `.config/nvim/nvim-pack-lock.json`; do not copy installed plugin directories. For SSH workspaces, install `ssh`, `sshfs` and `fusermount3`, and configure reachable literal Host aliases in your own `~/.ssh/config` (including any Include files). The config mounts a remote home under a private state directory and unmounts it on exit; supply your own SSH keys/agent. Password prompts for mounts are disabled. Neither SSH credentials nor Pi login state is part of this backup.
