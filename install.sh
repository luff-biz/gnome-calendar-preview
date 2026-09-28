#!/usr/bin/env bash
# Installs Calendar Preview into the user's GNOME Shell extension directory.
# The extension source of truth lives in this checkout; this only copies.
set -euo pipefail

UUID="gnome-calendar-preview@luff.biz"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

command -v rsync >/dev/null || { echo "rsync fehlt." >&2; exit 1; }

mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
glib-compile-schemas "$DEST/schemas"

# Übersetzungen kompilieren (gettext-Domain = Erweiterungs-UUID).
if command -v msgfmt >/dev/null; then
    for po in "$ROOT"/po/*.po; do
        lang="$(basename "$po" .po)"
        mkdir -p "$DEST/locale/$lang/LC_MESSAGES"
        msgfmt -o "$DEST/locale/$lang/LC_MESSAGES/$UUID.mo" "$po"
    done
else
    echo "Warnung: msgfmt fehlt — Übersetzungen wurden nicht kompiliert."
fi

echo "Installiert nach: $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Extension aktiviert."
else
    echo "Aktivierung nicht möglich (Extension ist der laufenden Sitzung unbekannt)."
    echo "Nach dem nächsten Anmelden:  gnome-extensions enable $UUID"
fi

echo
echo "Auf Wayland lädt eine neu installierte Extension erst nach erneutem Anmelden."
