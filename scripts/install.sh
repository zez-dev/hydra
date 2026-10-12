#!/usr/bin/env bash
# Install or update Hydra from source on Linux or macOS:
#   curl -fsSL https://raw.githubusercontent.com/zez-dev/hydra/main/scripts/install.sh | bash
# HYDRA_DIR (default ~/hydra) is the checkout; HYDRA_REPO overrides the clone URL.
# An existing checkout is updated with a fast-forward pull and rebuilt.
# Everything runs inside main, so a piped or truncated download never runs half a script.
set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

main() {
  local dir="${HYDRA_DIR:-$HOME/hydra}"
  local repo="${HYDRA_REPO:-https://github.com/zez-dev/hydra.git}"
  local os
  os="$(uname -s)"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  case "$os" in
    Linux | Darwin) ;;
    *) fail "this script supports Linux and macOS; see the README to run Hydra elsewhere" ;;
  esac

  say "Checking prerequisites"
  command -v git >/dev/null || fail "Git is required"
  command -v node >/dev/null || fail "Node.js 22.19 or newer (or 24 or newer) is required: https://nodejs.org"
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 24 || (major === 22 && minor >= 19) ? 0 : 1)' \
    || fail "Node.js $(node --version) is too old; install 22.19 or newer, or 24 or newer"
  if [ "$os" = Darwin ]; then
    xcode-select -p >/dev/null 2>&1 \
      || fail "the Xcode Command Line Tools are required: run xcode-select --install, then run this script again"
  elif ! command -v cc >/dev/null; then
    fail "a C compiler is required: install gcc (for example, sudo apt install build-essential)"
  fi
  if ! command -v pnpm >/dev/null; then
    command -v corepack >/dev/null || fail "pnpm is missing and so is Corepack; install Node.js from https://nodejs.org, which includes Corepack"
    say "Enabling pnpm through Corepack"
    # Node installed system-wide may not let Corepack write next to it; ~/.local/bin works without root.
    if ! corepack enable 2>/dev/null; then
      mkdir -p "$HOME/.local/bin"
      corepack enable --install-directory "$HOME/.local/bin"
      export PATH="$HOME/.local/bin:$PATH"
      printf 'pnpm was installed into ~/.local/bin; add that folder to PATH in your shell profile.\n'
    fi
  fi

  if [ -d "$dir/.git" ]; then
    say "Updating $dir"
    git -C "$dir" pull --ff-only
  else
    say "Cloning Hydra into $dir"
    # Only the latest commit: upstream's full history is large and running Hydra does not need it.
    git clone --depth 1 "$repo" "$dir"
  fi
  cd "$dir"

  say "Installing dependencies"
  pnpm install --frozen-lockfile

  say "Building (a few minutes)"
  pnpm run build:native-system
  pnpm run build:lib
  pnpm run build:web

  if [ "$os" = Linux ]; then
    local arch=''
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64 | arm64) arch=arm64 ;;
    esac
    if [ -n "$arch" ]; then
      say "Building the Linux sandbox launcher"
      local launcher="native/system/packages/linux-$arch/bin/landlock-run"
      mkdir -p "$(dirname "$launcher")"
      cc -std=c11 -Os -Wall -Wextra -Werror -s -o "$launcher" native/system/packages/entry/src/main.c
      "$launcher" --probe || printf 'The sandbox probe did not report full enforcement; run /doctor in Hydra for the fix.\n'
    fi
  fi

  say "Hydra is ready. Start it from the folder you want it to work in:"
  printf '  cd ~/my-project\n  node %s/apps/cli/lib/bin.js web\n' "$dir"
  printf 'Then open the printed link and add a model under Settings > Models.\n'
}

main "$@"
