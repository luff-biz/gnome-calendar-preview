#!/usr/bin/env python3
"""Beendet alles, was an einem bestimmten (privaten) D-Bus hängt.

Erkennungsmerkmal ist die Bus-Adresse in der Umgebung des jeweiligen Prozesses.
Damit bleibt die laufende Sitzung garantiert unberührt: deren Prozesse nennen
eine andere Adresse.

Aufruf: kill-private-bus.py <bus-adresse>
"""

import os
import signal
import sys
import time

SKIP_SIGNALS = (signal.SIGTERM,)


def processes_on_bus(address: bytes) -> list[int]:
    marker = b'DBUS_SESSION_BUS_ADDRESS=' + address
    mine = {os.getpid(), os.getppid()}
    found = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in mine:
            continue
        try:
            with open(f'/proc/{pid}/environ', 'rb') as handle:
                if marker in handle.read():
                    found.append(pid)
        except OSError:
            continue
    return found


def main():
    if len(sys.argv) < 2:
        print('Aufruf: kill-private-bus.py <bus-adresse>', file=sys.stderr)
        return 2

    address = sys.argv[1].encode()
    pids = processes_on_bus(address)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    for _ in range(20):
        remaining = processes_on_bus(address)
        if not remaining:
            break
        time.sleep(0.25)

    remaining = processes_on_bus(address)
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

    print(f'  private Sitzung: {len(pids)} Prozesse beendet'
          + (f', {len(remaining)} hart' if remaining else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
