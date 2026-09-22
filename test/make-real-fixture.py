#!/usr/bin/env python3
"""Schreibt echte Termine in eine Laufzeitdatei für den Stub des Shell-Tests:
Quell-UID, Termin-UID, Titel, Start, Ende, Ort.

Die Datei enthält echte Termindaten und wird deshalb **nicht versioniert**
(`.gitignore`: test/.runtime/) — sie gehört nicht in ein Repository.
Nur lesend; es wird nichts in den Kalendern verändert.
"""

import datetime
import json
import os
import sys

import gi

gi.require_version('EDataServer', '1.2')
gi.require_version('ECal', '2.0')
from gi.repository import ECal, EDataServer  # noqa: E402

LIMIT = 8
PAST_LIMIT = 3
LOOKAHEAD_DAYS = 60
PAST_DAYS = 7
TIMEZONE = 'Europe/Berlin'


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target_dir = os.path.join(here, '.runtime')
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, 'real-events.json')

    registry = EDataServer.SourceRegistry.new_sync(None)
    now = datetime.datetime.now()
    fmt = '%Y%m%dT%H%M%S'
    start = now.strftime(fmt)
    end = (now + datetime.timedelta(days=LOOKAHEAD_DAYS)).strftime(fmt)
    query = f'occur-in-time-range? (make-time "{start}") (make-time "{end}") "{TIMEZONE}"'

    events = []
    window_start = int(now.timestamp())
    window_end = int((now + datetime.timedelta(days=LOOKAHEAD_DAYS)).timestamp())
    past_start = int((now - datetime.timedelta(days=PAST_DAYS)).timestamp())

    past_queries = [
        (f'occur-in-time-range? (make-time "{(now - datetime.timedelta(days=PAST_DAYS)).strftime(fmt)}") '
         f'(make-time "{start}") "{TIMEZONE}"', True),
        (query, False),
    ]

    past_events = []
    for source in registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR):
        if not source.get_enabled():
            continue
        try:
            client = ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS, 0, None)
        except Exception as exc:  # noqa: BLE001
            print(f'{source.get_display_name()}: übersprungen — {exc}', file=sys.stderr)
            continue

        for past_query, is_past in past_queries:
            try:
                _ok, comps = client.get_object_list_as_comps_sync(past_query, None)
            except Exception as exc:  # noqa: BLE001
                print(f'{source.get_display_name()}: Abfrage fehlgeschlagen — {exc}', file=sys.stderr)
                continue

            for comp in comps or []:
                dtstart = comp.get_dtstart()
                dtend = comp.get_dtend()
                if dtstart is None or dtend is None:
                    continue
                start_time = dtstart.get_value()
                end_time = dtend.get_value()
                # dtstart eines Serientermins ist der Serienbeginn, nicht das
                # Vorkommen im Fenster — deshalb nur echte Einzeltermine und
                # keine Ganztagstermine (Datumswerte, hier nicht verlässlich).
                if start_time.is_date() or end_time.is_date():
                    continue
                start_ts = int(start_time.as_timet())
                end_ts = int(end_time.as_timet())
                entry = {
                    'source_uid': source.get_uid(),
                    'event_uid': comp.get_uid(),
                    'summary': (comp.get_summary().get_value() if comp.get_summary() else None) or 'Ohne Titel',
                    'start': start_ts,
                    'end': end_ts,
                    'location': comp.get_location(),
                }
                if is_past:
                    if past_start <= start_ts <= window_start:
                        past_events.append(entry)
                elif window_start <= start_ts <= window_end:
                    events.append(entry)

    events.sort(key=lambda e: e['start'])
    events = events[:LIMIT]
    past_events.sort(key=lambda e: e['end'], reverse=True)
    past_events = list(reversed(past_events[:PAST_LIMIT]))
    events = past_events + events

    with open(target, 'w', encoding='utf-8') as handle:
        json.dump(events, handle, ensure_ascii=False, indent=2)

    with_location = sum(1 for e in events if e['location'])
    print(f'{len(events)} Termine geschrieben nach {target} '
          f'({len(past_events)} vergangen, {with_location} mit Ort)')


if __name__ == '__main__':
    main()
