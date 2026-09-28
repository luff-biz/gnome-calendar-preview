#!/usr/bin/env bash
# Prüft, ob das Einstellungsfenster der Extension fehlerfrei startet — ohne die
# laufende Sitzung zu berühren: private D-Bus-Sitzung, privates dconf, eine
# kopf-lose Shell mit virtuellem Monitor als Anzeige.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="gnome-calendar-preview@luff.biz"
EXTDIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
export GSETTINGS_SCHEMA_DIR="$EXTDIR/schemas:/usr/share/glib-2.0/schemas"

if [ "${1:-}" != "--inner" ]; then
    export XDG_CONFIG_HOME="$HERE/cfg"
    rm -rf "$XDG_CONFIG_HOME"
    mkdir -p "$XDG_CONFIG_HOME"
    # Klassischer dbus-daemon statt dbus-broker: Letzterer aktiviert Dienste über
    # systemd, das es in einer privaten Sitzung nicht gibt — die
    # Accessibility-Kette (org.a11y.Bus → Registry) käme sonst nicht hoch.
    BUS_INFO="$(dbus-daemon --session --fork --print-address=1 --print-pid=1 --nopidfile)"
    export DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "$BUS_INFO" | sed -n 1p)"
    export TEST_BUS_PID="$(printf '%s\n' "$BUS_INFO" | sed -n 2p)"
    exec bash "$0" --inner
fi

RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
WL="wl-prefstest-$$"

gnome-shell --headless --wayland --no-x11 --wayland-display="$WL" \
    --virtual-monitor 1280x800 > "$HERE/prefs-shell.log" 2>&1 &
SHELL_PID=$!

for _ in $(seq 1 80); do
    [ -S "$RUNTIME/$WL" ] && break
    sleep 0.25
done

if [ ! -S "$RUNTIME/$WL" ]; then
    echo "ERGEBNIS: keine Wayland-Anzeige zustande gekommen"
    kill "$SHELL_PID" 2>/dev/null
    exit 1
fi
echo "Anzeige: $RUNTIME/$WL"
echo "Bus: $DBUS_SESSION_BUS_ADDRESS"

# In einer privaten Sitzung fehlt die Accessibility-Brücke, an der GTK beim
# Registrieren der Anwendung hängen bleibt. Also selbst starten.
A11Y_PID=""
if [ -x /usr/libexec/at-spi-bus-launcher ]; then
    /usr/libexec/at-spi-bus-launcher --launch-immediately \
        > "$HERE/prefs-a11y.log" 2>&1 &
    A11Y_PID=$!
    for _ in $(seq 1 24); do
        gdbus call --session --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.NameHasOwner org.a11y.Bus 2>/dev/null |
            grep -q true && break
        sleep 0.25
    done
fi

# GTK_A11Y=none: in einer privaten Sitzung gibt es keine Accessibility-Brücke,
# GTK bricht sonst beim Registrieren der Anwendung ab.
WAYLAND_DISPLAY="$WL" GDK_BACKEND=wayland GTK_A11Y=none NO_AT_BRIDGE=1 \
    gnome-extensions prefs "$UUID" > "$HERE/prefs.log" 2>&1 &
PREFS_PID=$!

sleep 8

LIVE_PREFS="$(pgrep -af 'org.gnome.Shell.Extensions|gnome-extensions prefs' | grep -v "$$" | tr '\n' ';')"

echo "Laufende Prozesse: ${LIVE_PREFS:-(keine)}"

if [ -n "$LIVE_PREFS" ] || kill -0 "$PREFS_PID" 2>/dev/null; then
    echo "ERGEBNIS: Einstellungsprozess läuft"
    STATUS=0
else
    echo "ERGEBNIS: kein Einstellungsprozess mehr vorhanden"
    STATUS=1
fi

kill "$PREFS_PID" 2>/dev/null
# Der Startvorgang gibt das eigentliche Fenster an einen gjs-Kindprozess ab.
pkill -f 'gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensio[n]s' 2>/dev/null
kill "$SHELL_PID" 2>/dev/null
[ -n "$A11Y_PID" ] && kill "$A11Y_PID" 2>/dev/null
[ -n "${TEST_BUS_PID:-}" ] && kill "$TEST_BUS_PID" 2>/dev/null
sleep 1
pkill -f "gnome-shell --headles[s]" 2>/dev/null
rm -f "$RUNTIME/$WL"

LEFTOVER="$(pgrep -cf 'gnome-shell --headles[s]|org.gnome.Shell.Extensio[n]s' || true)"
echo "Aufgeräumt. Verbliebene Testprozesse: ${LEFTOVER:-0}"

echo
echo "--- Ausgabe des Einstellungsprozesses ---"
if [ -s "$HERE/prefs.log" ]; then
    sed 's/^/  /' "$HERE/prefs.log"
else
    echo "  (leer — kein Fehler)"
fi

exit "$STATUS"
