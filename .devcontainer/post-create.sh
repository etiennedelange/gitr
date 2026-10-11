#!/usr/bin/env bash
#
# Dev container postCreateCommand. webkit2gtk/gtk3/etc. are Tauri build-time
# deps (pkg-config, linked by the tao/wry/webkit2gtk crates), needed for
# `cargo test --workspace` even though this container never runs the app.
# Gitr targets Windows; build installers there.
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Docker creates the Claude config volume root-owned on first mount.
sudo chown -R vscode:vscode /home/vscode/.claude
# The dev container also mounts node_modules, ui/node_modules and target as volumes.
for d in node_modules ui/node_modules target; do
	[ -d "$d" ] && sudo chown vscode:vscode "$d"
done

sudo apt-get update
sudo apt-get install -y \
	libwebkit2gtk-4.1-dev \
	libgtk-3-dev \
	librsvg2-dev \
	libayatana-appindicator3-dev \
	libssl-dev \
	libxdo-dev \
	patchelf \
	pkg-config

pnpm install

# Headless Chromium and its system libraries, for `pnpm screenshots`.
pnpm exec playwright install --with-deps chromium

# ─── OpenCode CLI ─────────────────────────────────────────────────────────────
# No official devcontainer feature exists for OpenCode (unlike Claude Code), so
# install via the official installer. The binary, global config and auth/session
# data are persisted as named volumes mounted in devcontainer.json, so auth and
# plugins survive rebuilds — only the ~/.opencode/bin binary is (re)installed here.
echo "--> Installing OpenCode CLI..."
export PATH="$HOME/.opencode/bin:$PATH"
if command -v opencode >/dev/null 2>&1; then
  echo "    opencode already installed ($(opencode --version)) — upgrading..."
  opencode upgrade || echo "    Warning: opencode upgrade failed — will try again on next startup"
else
  curl -fsSL https://opencode.ai/install | bash \
    || echo "    Warning: opencode install failed — run 'curl -fsSL https://opencode.ai/install | bash' manually"
fi
if ! grep -q '.opencode/bin' ~/.bashrc 2>/dev/null; then
  echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc
fi
echo "    opencode $(opencode --version 2>/dev/null || echo 'not yet on PATH — reload shell')"


# ─── OpenCode user config ────────────────────────────────────────────────────
# Symlink the global opencode config to a committed file in .devcontainer/ so
# changes are always version-controlled, mirroring the Claude settings link
# above. The named volume mount keeps auth + plugins persisted across rebuilds.
echo "--> Linking OpenCode user config..."
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.jsonc"
REPO_OPENCODE_CONFIG="$(pwd)/.devcontainer/opencode-settings.jsonc"
if [ ! -L "$OPENCODE_CONFIG" ] || [ "$(readlink "$OPENCODE_CONFIG")" != "$REPO_OPENCODE_CONFIG" ]; then
  # Seed repo file from existing config if it has content
  if [ -f "$OPENCODE_CONFIG" ] && [ ! -L "$OPENCODE_CONFIG" ] && [ -s "$OPENCODE_CONFIG" ] && [ ! -s "$REPO_OPENCODE_CONFIG" ]; then
    cp "$OPENCODE_CONFIG" "$REPO_OPENCODE_CONFIG"
  fi
  rm -f "$OPENCODE_CONFIG"
  ln -s "$REPO_OPENCODE_CONFIG" "$OPENCODE_CONFIG"
  echo "    Linked $OPENCODE_CONFIG -> $REPO_OPENCODE_CONFIG"
else
  echo "    Already linked — skipping"
fi

# Ensure the node user owns the opencode config/data dirs for credential storage
sudo chown node:node /home/node/.config/opencode /home/node/.local/share/opencode /home/node/.opencode 2>/dev/null || true

git config --global gpg.format ssh
git config --global commit.gpgsign true
git config --global user.signingkey 'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKrav6iKAK+xCH3v5tt3r4D/JyQPnFzfcFwFIUPEouav'
git config --global user.name "Etienne de Lange"
git config --global user.email "etienne.de.lange1@gmail.com"
mkdir -p ~/.config/git
printf '%s namespaces="git" %s\n' "etienne.de.lange1@gmail.com" "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKrav6iKAK+xCH3v5tt3r4D/JyQPnFzfcFwFIUPEouav" > ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
git config --global alias.sigs "log --format='%G? %h %<(22,trunc)%GS %s'"
