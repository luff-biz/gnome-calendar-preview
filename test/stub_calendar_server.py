#!/usr/bin/env python3
"""Stub for org.gnome.Shell.CalendarServer.

Owns the bus name on the (private) session bus and pushes synthetic
appointments as soon as SetTimeRange is called, so the extension can be tested
end to end without touching real calendars.

Signatures mirror gnome-shell 50's calendar-server:
  SetTimeRange(x since, x until, b force_reload)
  EventsAddedOrUpdated(a(ssxxa{sv}))
  EventsRemoved(as)
  properties Since, Until, HasCalendars
"""

import datetime
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = 'org.gnome.Shell.CalendarServer'
PATH = '/org/gnome/Shell/CalendarServer'
IFACE = 'org.gnome.Shell.CalendarServer'

NODE_XML = """
<node>
  <interface name='org.gnome.Shell.CalendarServer'>
    <method name='SetTimeRange'>
      <arg type='x' name='since' direction='in'/>
      <arg type='x' name='until' direction='in'/>
      <arg type='b' name='force_reload' direction='in'/>
    </method>
    <signal name='EventsAddedOrUpdated'>
      <arg type='a(ssxxa{sv})' name='events'/>
    </signal>
    <signal name='EventsRemoved'>
      <arg type='as' name='ids'/>
    </signal>
    <property name='Since' type='x' access='read'/>
    <property name='Until' type='x' access='read'/>
    <property name='HasCalendars' type='b' access='read'/>
  </interface>
</node>
"""

# Expectations the test driver checks against:
# 6 entries, chronologically, all-day entries included.
EXPECTED = ['Zahnarzt', 'Kundentermin', 'Team-Sync', 'Feiertag',
            'Vorstandssitzung', 'Herbstferien']


def build_events():
    now = datetime.datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day = datetime.timedelta(days=1)

    def at(offset_days, hour, minute=0):
        return midnight + day * offset_days + datetime.timedelta(hours=hour, minutes=minute)

    plan = [
        ('Zahnarzt', now + datetime.timedelta(hours=2), datetime.timedelta(minutes=90)),
        ('Kundentermin', now + datetime.timedelta(hours=5), datetime.timedelta(minutes=60)),
        ('Team-Sync', at(1, 9), datetime.timedelta(minutes=60)),
        ('Feiertag', at(3, 0), day),                    # ganztägig
        ('Vorstandssitzung', at(6, 16), datetime.timedelta(minutes=60)),
        ('Herbstferien', at(9, 0), day * 3),            # ganztägig, mehrtägig
        ('Steuertermin', at(14, 10), datetime.timedelta(minutes=60)),
        ('Reise', at(20, 8), datetime.timedelta(hours=5)),
    ]

    events = []
    for summary, start, duration in plan:
        events.append((f'stub\n{summary}\n', summary,
                       int(start.timestamp()), int((start + duration).timestamp()),
                       {}))
    return events


def events_variant(events):
    """Build a(ssxxa{sv}) explicitly — the PyGObject override mis-parses the
    nested dict when handed a whole nested Python structure at once."""
    children = [GLib.Variant('(ssxxa{sv})', event) for event in events]
    return GLib.Variant.new_tuple(
        GLib.Variant.new_array(GLib.VariantType('(ssxxa{sv})'), children))


class Stub:
    def __init__(self, connection):
        self._connection = connection
        self._since = 0
        self._until = 0
        self._sent = False

    def handle_method_call(self, connection, sender, path, iface, method, params, invocation):
        if method != 'SetTimeRange':
            invocation.return_error_literal(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, 'unknown method')
            return
        self._since, self._until, _force = params.unpack()
        print(f'[stub] SetTimeRange since={self._since} until={self._until}', flush=True)
        invocation.return_value(None)
        if not self._sent:
            self._sent = True
            GLib.timeout_add(400, self._push)

    def _push(self):
        try:
            events = build_events()
            self._connection.emit_signal(None, PATH, IFACE,
                                         'EventsAddedOrUpdated', events_variant(events))
            print(f'[stub] pushed {len(events)} events', flush=True)
        except Exception as exc:  # noqa: BLE001
            self._sent = False
            print(f'[stub] push failed: {exc!r}', flush=True)
        return GLib.SOURCE_REMOVE

    def handle_get_property(self, connection, sender, path, iface, name):
        if name == 'Since':
            return GLib.Variant('x', self._since)
        if name == 'Until':
            return GLib.Variant('x', self._until)
        if name == 'HasCalendars':
            return GLib.Variant('b', True)
        return None


def main():
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    stub = Stub(connection)
    info = Gio.DBusNodeInfo.new_for_xml(NODE_XML)
    connection.register_object(PATH, info.interfaces[0], stub.handle_method_call,
                               stub.handle_get_property, None)

    loop = GLib.MainLoop()
    owned = Gio.bus_own_name_on_connection(connection, BUS_NAME,
                                           Gio.BusNameOwnerFlags.NONE, None, None)
    print(f'[stub] ready, owning {BUS_NAME}', flush=True)

    def stop():
        loop.quit()
        return GLib.SOURCE_REMOVE

    GLib.timeout_add_seconds(60, stop)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, stop)  # SIGTERM
    loop.run()
    Gio.bus_unown_name(owned)
    print('[stub] bye', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
