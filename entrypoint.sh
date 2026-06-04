#!/bin/bash
ln -sf /home/node/.claude/.claude.json /home/node/.claude.json 2>/dev/null || true
exec "$@"
