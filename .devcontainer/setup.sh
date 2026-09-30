#!/usr/bin/env bash
set -e

source "${NVM_DIR}/nvm.sh" --no-use
nvm install
nvm alias default "$(nvm current)"
npm install --global "$(node -p 'require("./package.json").packageManager')"
pnpm install --frozen-lockfile
