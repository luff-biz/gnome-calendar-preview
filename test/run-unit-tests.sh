#!/usr/bin/env bash
# Runs the unit tests for the pure appointment logic.
# Copies the module under test next to the test file first, so what is tested is
# always the current source (no duplicated copy in the repo).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../gnome-productive-calendar@luff.biz/lib/appointments.js"

cp "$SRC" "$HERE/appointments.mjs"
gjs -m "$HERE/appointments.test.mjs"
