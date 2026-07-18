#!/bin/bash
set -e
exec "$(cd "$(dirname "$0")" && pwd -P)/scripts/restore-macos.sh"
