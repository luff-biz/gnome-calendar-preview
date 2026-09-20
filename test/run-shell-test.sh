#!/usr/bin/env bash
# End-to-end smoke test for the installed extension, without touching the live
# session: private D-Bus session, private dconf, stub calendar server, headless
# gnome-shell. Proves that the extension loads, takes the place of the native
# day list and renders the appointments that are pushed over D-Bus.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="gnome-productive-calendar@luff.biz"
EXTDIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
export GSETTINGS_SCHEMA_DIR="$EXTDIR/schemas:/usr/share/glib-2.0/schemas"

if [ "${1:-}" != "--inner" ]; then
    export CONTROL_MODE="${CONTROL_MODE:-0}"
    export XDG_CONFIG_HOME="$HERE/cfg"
    rm -rf "$XDG_CONFIG_HOME"
    mkdir -p "$XDG_CONFIG_HOME"
    exec dbus-run-session -- bash "$0" --inner
fi

SETTINGS="org.gnome.shell.extensions.gnome-productive-calendar"

gsettings set org.gnome.shell disable-user-extensions false
if [ "$CONTROL_MODE" = "1" ]; then
    # Control run: same shell, same stub, but without the extension — used to
    # attribute shell-side log noise.
    gsettings set org.gnome.shell enabled-extensions "[]"
    echo "Kontrolllauf: Extension NICHT aktiviert"
else
    gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    gsettings set "$SETTINGS" debug-logging true
    echo "Vorgaben: event-count=$(gsettings get "$SETTINGS" event-count) lookahead-days=$(gsettings get "$SETTINGS" lookahead-days)"
fi

python3 "$HERE/stub_calendar_server.py" > "$HERE/stub.log" 2>&1 &
STUB=$!
for _ in $(seq 1 40); do
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell.CalendarServer 2>/dev/null |
        grep -q true && break
    sleep 0.25
done
echo "Stub: $(head -1 "$HERE/stub.log")"

gnome-shell --headless --wayland > "$HERE/headless-shell.log" 2>&1 &
SHELL_PID=$!
for _ in $(seq 1 120); do
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2>/dev/null |
        grep -q true && break
    sleep 0.25
done

sleep 8

gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" > "$HERE/extension-info.txt" 2>&1

kill "$SHELL_PID" "$STUB" 2>/dev/null
sleep 1
pkill -f 'gnome-shell --headless' 2>/dev/null
sleep 1

echo
echo "=== Extension-Status ==="
python3 - "$HERE/extension-info.txt" <<'PY'
import ast, re, sys
raw = open(sys.argv[1]).read()
states = {1: 'ENABLED', 2: 'DISABLED', 3: 'ERROR', 4: 'OUT_OF_DATE', 5: 'DOWNLOADING'}
m = re.search(r"'state': <(\d+)>", raw)
if m:
    code = int(m.group(1))
    print(f"  state: {code} ({states.get(code, 'unbekannt')})")
    if code == 3:
        err = re.search(r"'error': <'([^']*)'>", raw)
        print(f"  FEHLER: {err.group(1) if err else 'unbekannt'}")
else:
    print('  kein Status lesbar:', raw[:300])
PY

echo
echo "=== Zeilen der Extension im Shell-Log ==="
grep -F '[productive-calendar]' "$HERE/headless-shell.log" | sed 's/^/  /' || echo "  (keine)"

echo
echo "=== Prüfung: gerenderte Liste ==="
python3 - "$HERE/headless-shell.log" <<'PY'
import sys

log = open(sys.argv[1], encoding='utf-8', errors='replace').read()
lines = [l for l in log.splitlines() if 'render' in l]
if not lines:
    print('  FAIL  keine render-Zeile gefunden')
    raise SystemExit(0)

def entries(line):
    return [s.strip() for s in line.split('): ', 1)[-1].split(' | ') if s.strip()]

# The richest render line: later ones during teardown are empty by design.
shown = max((entries(l) for l in lines), key=len)
print(f'  gerendert: {shown}')

# Same plan as test/stub_calendar_server.py
expected = ['Zahnarzt', 'Kundentermin', 'Team-Sync', 'Feiertag',
            'Vorstandssitzung', 'Herbstferien']

missing = [name for name in expected if name not in shown]
if missing:
    print(f'  FAIL  fehlen: {missing}')
else:
    order = [shown.index(name) for name in expected]
    if order == sorted(order):
        print('  PASS  alle 6 erwarteten Termine, chronologisch')
    else:
        print(f'  FAIL  Reihenfolge stimmt nicht: {order}')
if len(shown) > len(expected):
    print(f'  HINWEIS  {len(shown)} Einträge gerendert')
PY

echo
echo "=== Fehler im Shell-Log (Auszug) ==="
grep -iE 'error|exception|traceback|undefined|not a function' "$HERE/headless-shell.log" |
    grep -v 'calendar-server' | head -15 | sed 's/^/  /' || true
echo "  (Logdatei: $HERE/headless-shell.log, $(wc -l < "$HERE/headless-shell.log") Zeilen)"
