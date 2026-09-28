#!/usr/bin/env bash
# Installs Calendar Preview into the user's GNOME Shell extension directory.
# The extension source of truth lives in this checkout; this only copies.
set -euo pipefail

UUID="gnome-calendar-preview@luff.biz"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

command -v rsync >/dev/null || { echo "rsync fehlt." >&2; exit 1; }

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
glib-compile-schemas "$DEST/schemas"

echo "Installiert nach: $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Extension aktiviert."
else
    echo "Aktivierung nicht möglich (Extension ist der laufenden Sitzung unbekannt)."
    echo "Nach dem nächsten Anmelden:  gnome-extensions enable $UUID"
fi

echo
echo "Auf Wayland lädt eine neu installierte Extension erst nach erneutem Anmelden."
