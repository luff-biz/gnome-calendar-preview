# Tests

## Unit tests — the appointment logic

```sh
./run-unit-tests.sh
```

Copies `gnome-productive-calendar@luff.biz/lib/appointments.js` next to the test
file and runs it with plain `gjs`, so the module under test is always the current
source. Covers all-day detection, filtering of past entries, chronological order,
the count limit, the "when" strings and the window-widening rule.

## End-to-end test — inside a real shell

```sh
./run-shell-test.sh          # with the extension
CONTROL_MODE=1 ./run-shell-test.sh   # control run, extension disabled
```

Runs in complete isolation and does **not** touch the running desktop session:

- private D-Bus session (`dbus-run-session`) and private dconf
  (`XDG_CONFIG_HOME=test/cfg`), so the real `enabled-extensions` is untouched
- `stub_calendar_server.py` owns `org.gnome.Shell.CalendarServer` on that private
  bus and pushes eight synthetic appointments, including two all-day entries
- `gnome-shell --headless --wayland` loads the *installed* extension and logs to
  `headless-shell.log`

The run passes when the extension reports `render 6/6` with the six expected
summaries in chronological order, and when the container log line shows the
upcoming list in the place of the native day list
(`container=[events-button productive-calendar-section, …]`).

The control run exists to attribute log noise: it runs the same shell and the
same stub without the extension. A `JS ERROR: TypeError: can't access property
"attach", layout is null` in `resource:///org/gnome/shell/ui/calendar.js` appears
**in both runs** — it is shell-side teardown noise when the calendar server's bus
name disappears, not something the extension causes.

The extension has to be installed first (`../install.sh`); the test drives the
installed copy, like the shell does.

## Settings window

```sh
./run-prefs-test.sh
```

Opens the extension's settings window on a virtual monitor in an isolated
session (private bus, private dconf, headless shell) and checks that the process
stays up and logs nothing. Two environment details matter:

- a **classic `dbus-daemon`** is used instead of `dbus-run-session`, because
  dbus-broker activates services through systemd, which does not exist in a
  private session — the accessibility chain (`org.a11y.Bus` → registry) would
  otherwise fail and GTK would abort while registering the application
- `GTK_A11Y=none` additionally keeps GTK from insisting on that chain

A screenshot of the window is **not** part of this test: `org.gnome.Shell.Screenshot`
refuses calls that do not come from the shell itself (`Screenshot is not allowed`).
The evidence is the running process plus an empty error log — a mistyped or
missing settings key would surface as a GSettings warning there.
