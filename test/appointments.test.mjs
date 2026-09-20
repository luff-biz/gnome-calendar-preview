// Unit tests for the pure appointment logic.
// Run through test/run-unit-tests.sh, which copies the module under test next to
// this file first — so the copy is always the current source.

import System from 'system';

import * as A from './appointments.mjs';

let checks = 0;
let failures = 0;

function ok(condition, label, detail = '') {
    checks++;
    if (condition) {
        print(`ok    ${label}`);
    } else {
        failures++;
        print(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
    }
}

function eq(actual, expected, label) {
    ok(actual === expected, label, `erwartet: ${expected}  bekommen: ${actual}`);
}

// 20.09.2026 is a Sunday; use a fixed local reference time so the tests do not
// depend on when they run.
const now = new Date(2026, 8, 20, 14, 30, 0);
const at = (dayOffset, hours, minutes = 0) =>
    new Date(2026, 8, 20 + dayOffset, hours, minutes, 0);

const event = (summary, start, end) => ({id: `test\n${summary}`, date: start, end, summary});

const past = event('Vergangen', at(0, 9), at(0, 10));
const running = event('Läuft gerade', at(0, 14), at(0, 15, 30));
const later = event('Heute später', at(0, 18), at(0, 19, 30));
const tomorrow = event('Morgen früh', at(1, 9), at(1, 10, 30));
const allDay3 = event('Feiertag', at(3, 0), at(4, 0));
const inSix = event('Sitzung', at(6, 16), at(6, 17));
const allDay9 = event('Ferien', at(9, 0), at(12, 0));
const in14 = event('Steuertermin', at(14, 10), at(14, 11));
const in20 = event('Reise', at(20, 8), at(20, 9));

const all = [in20, past, tomorrow, allDay9, running, allDay3, in14, later, inSix];

// ---- isAllDay ------------------------------------------------------------

ok(A.isAllDay(allDay3), 'isAllDay: Mitternacht bis Mitternacht');
ok(A.isAllDay(allDay9), 'isAllDay: mehrtägig ab Mitternacht');
ok(!A.isAllDay(later), 'isAllDay: 18:00–19:30 ist kein Ganztagstermin');
ok(!A.isAllDay(event('X', at(0, 0), at(0, 0, 30))), 'isAllDay: 00:00–00:30 ist kein Ganztagstermin');
ok(!A.isAllDay(event('Y', at(0, 0), at(1, 10))), 'isAllDay: Mitternacht bis 10 Uhr ist kein Ganztagstermin');

// ---- isRunning / dayIndex ------------------------------------------------

ok(A.isRunning(running, now), 'isRunning: laufender Termin');
ok(!A.isRunning(later, now), 'isRunning: späterer Termin');
ok(!A.isRunning(past, now), 'isRunning: beendeter Termin');
eq(A.dayIndex(at(0, 0), now), 0, 'dayIndex: heute');
eq(A.dayIndex(at(1, 0), now), 1, 'dayIndex: morgen');
eq(A.dayIndex(at(3, 0), now), 3, 'dayIndex: in drei Tagen');
eq(A.dayIndex(at(-1, 0), now), -1, 'dayIndex: gestern');

// ---- upcomingEvents ------------------------------------------------------

const six = A.upcomingEvents(all, now, {count: 6, showAllDay: true});
eq(six.length, 6, 'upcomingEvents: Anzahl begrenzt');
eq(six.map(e => e.summary).join(','),
    'Läuft gerade,Heute später,Morgen früh,Feiertag,Sitzung,Ferien',
    'upcomingEvents: chronologisch, vergangene gefiltert, laufende enthalten');

const withoutAllDay = A.upcomingEvents(all, now, {count: 6, showAllDay: false});
eq(withoutAllDay.map(e => e.summary).join(','),
    'Läuft gerade,Heute später,Morgen früh,Sitzung,Steuertermin,Reise',
    'upcomingEvents: Ganztagstermine ausgeschlossen');

const three = A.upcomingEvents(all, now, {count: 3, showAllDay: true});
eq(three.map(e => e.summary).join(','), 'Läuft gerade,Heute später,Morgen früh',
    'upcomingEvents: count wird beachtet');

const endingNow = event('Endet jetzt', at(0, 13, 30), now);
ok(A.upcomingEvents([endingNow], now, {count: 6}).length === 0,
    'upcomingEvents: genau jetzt endender Termin fällt raus');

ok(A.upcomingEvents([], now, {count: 6}).length === 0,
    'upcomingEvents: leere Liste bleibt leer');

// ---- formatting ----------------------------------------------------------

const strings = {today: 'Today', tomorrow: 'Tomorrow', allDay: 'all day', nowUntil: 'now–%s'};
const pad = n => String(n).padStart(2, '0');
const timeOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

eq(A.formatWhen(running, now, strings, timeOf), 'now–15:30', 'formatWhen: laufender Termin');
eq(A.formatWhen(later, now, strings, timeOf), '18:00–19:30', 'formatWhen: heute später nur Uhrzeit');
eq(A.formatWhen(tomorrow, now, strings, timeOf), 'Tomorrow · 09:00–10:30',
    'formatWhen: morgen mit Tagesangabe');
const allDayText = A.formatWhen(allDay3, now, strings, timeOf);
ok(allDayText.endsWith('· all day'), 'formatWhen: Ganztagstermin gekennzeichnet', allDayText);
ok(/^[^\s]+ 23\.09\. · all day$/.test(allDayText),
    'formatWhen: Ganztagstermin nennt Tag und Datum', allDayText);
eq(A.dayLabel(at(0, 12), now, strings, timeOf), 'Today', 'dayLabel: heute');
eq(A.dayLabel(at(1, 12), now, strings, timeOf), 'Tomorrow', 'dayLabel: morgen');
ok(/^[^\s]+ 05\.10\.$/.test(A.dayLabel(at(15, 12), now, strings, timeOf)),
    'dayLabel: späteres Datum als Wochentag + Datum',
    A.dayLabel(at(15, 12), now, strings, timeOf));

// Default formatter (no injection) must stay 24-hour local time.
eq(A.defaultTimeOf(at(0, 8, 5)), '08:05', 'defaultTimeOf: HH:MM');

// ---- widenedWindow -------------------------------------------------------

eq(A.widenedWindow(120, 6, 6, 730), 120, 'widenedWindow: genug Treffer, keine Änderung');
eq(A.widenedWindow(120, 3, 6, 730), 240, 'widenedWindow: verdoppelt bei zu wenig Treffern');
eq(A.widenedWindow(600, 1, 6, 730), 730, 'widenedWindow: auf MAX begrenzt');
eq(A.widenedWindow(730, 0, 6, 730), 730, 'widenedWindow: wächst nicht über MAX');

// ---- result --------------------------------------------------------------

print('');
print(`${checks - failures}/${checks} Prüfungen bestanden`);
if (failures > 0)
    printerr(`${failures} Fehlschläge`);
imports.system.exit(failures > 0 ? 1 : 0);
