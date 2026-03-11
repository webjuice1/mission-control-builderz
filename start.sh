#!/bin/bash
cd /Users/clowdbot/Documents/mission-control-v2/.next/standalone

# Load env vars from .env
set -a
source /Users/clowdbot/Documents/mission-control-v2/.env
set +a

export HOSTNAME=0.0.0.0
export PORT=4005

exec /opt/homebrew/bin/node server.js
