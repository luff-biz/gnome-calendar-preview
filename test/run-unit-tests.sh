#!/usr/bin/env bash
# Runs the unit tests for the pure appointment logic.
# Copies the module under test next to the test file first, so what is tested is
# always the current source (no duplicated copy in the repo).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/../gnome-productive-calendar@luff.biz"
SRC="$EXT/lib/appointments.js"

cp "$SRC" "$HERE/appointments.mjs"
gjs -m "$HERE/appointments.test.mjs"

# Zweite Prüfung: jeder Name, den extension.js aus der Bibliothek holt, muss dort
# auch exportiert sein. Ein fehlender Export ist sonst erst in der Shell zu
# sehen — und dann lädt die Extension überhaupt nicht (schon einmal passiert).
python3 - "$EXT/extension.js" "$SRC" <<'PY'
import re
import sys

extension, library = sys.argv[1], sys.argv[2]
source = open(library, encoding='utf-8').read()
code = open(extension, encoding='utf-8').read()

match = re.search(r"import \{([^}]*)\}\s+from '\./lib/appointments\.js'", code, re.S)
if not match:
    print('FAIL  Import aus lib/appointments.js nicht gefunden')
    sys.exit(1)

imported = [name.strip() for name in match.group(1).split(',') if name.strip()]
exported = set(re.findall(r'export (?:function|const) (\w+)', source))
missing = [name for name in imported if name not in exported]

if missing:
    print(f'FAIL  extension.js holt Namen, die die Bibliothek nicht exportiert: {missing}')
    sys.exit(1)
print(f'ok    Importe gedeckt: {len(imported)} Namen, alle exportiert')
PY
