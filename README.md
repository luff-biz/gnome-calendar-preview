# Calendar Preview

A GNOME Shell extension that replaces the date menu's single-day event list with
the **next N appointments**, regardless of day boundaries.

## Why

GNOME's calendar popup is built around one day at a time: the month grid picks a
date, and the list underneath shows that date's entries only — by default today.
That is a fine reminder and a poor planning tool, because from a planning
perspective today is mostly gone.

Calendar Preview keeps the date menu where it is and puts a rolling list of
the upcoming appointments in place of the day list. Number of entries, all-day
handling and the lookahead window are configurable.

## Requirements

- GNOME Shell 50 (verified on 50.4). Other versions are untested — the extension
  reaches into the date menu's internals, which do change between releases.
- Calendars configured in GNOME (Evolution Data Server via GNOME Online
  Accounts). Without calendars the native day list stays in place.

## Install

```sh
./install.sh
```

This copies the extension to `~/.local/share/gnome-shell/extensions/` and
compiles the settings schema. **On Wayland a newly installed extension is only
picked up after logging out and back in** — there is no `Alt+F2` + `r` on
Wayland.

## Settings

```sh
gnome-extensions prefs gnome-calendar-preview@luff.biz
```

The settings window is currently labelled in German.

- **Monatsgitter ausblenden** — hides the month grid in the date menu, leaving
  the day header and the appointment list (default: **on**)
- **Anzahl der Termine** — how many entries the list shows (default: **6**)
- **Ganztägige Termine anzeigen** — births, holidays, school breaks (default: on)
- **Vorschau-Zeitraum** — days asked for up front (default: 120), widened
  automatically when the window does not hold enough entries
- **Klick öffnet GNOME Calendar** (default: **off**)
- **Ins Journal protokollieren** — troubleshooting (default: off)

## How it works

The extension uses the shell's own calendar plumbing rather than reading
Evolution's cache files: `resource:///org/gnome/shell/ui/calendar.js` exposes
`DBusEventSource`, which talks to `org.gnome.Shell.CalendarServer` on the session
bus. That service expands recurring appointments server-side and pushes changes
via `EventsAddedOrUpdated` / `EventsRemoved`, so no polling is involved.

The month grid and the extension share one time range on that service — it is
global state, not per client. The extension therefore re-asserts its own window
shortly after the date menu opens, because the grid sets the visible month at
that moment.

While you browse a different day in the month grid, the native day list takes
over again, so the extension never takes that capability away.

## Licence

MIT — see `LICENSE`.
