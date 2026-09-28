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

// Fester Bezugszeitpunkt (So 20.09.2026, 14:30 lokal), damit die Tests nicht
// davon abhängen, wann sie laufen.
const now = new Date(2026, 8, 20, 14, 30, 0);
const at = (dayOffset, hours, minutes = 0) =>
    new Date(2026, 8, 20 + dayOffset, hours, minutes, 0);

const event = (summary, start, end, uid = summary) => ({
    id: `quell-uid\n${uid}\n`,
    date: start,
    end,
    summary,
});

const past = event('Vergangen', at(-1, 9), at(-1, 10));
const finishedToday = event('Heute früh', at(0, 9), at(0, 10));
const running = event('Läuft gerade', at(0, 14), at(0, 15, 30));
const later = event('Heute später', at(0, 18), at(0, 19, 30));
const tomorrow = event('Morgen früh', at(1, 9), at(1, 10, 30));
const allDay3 = event('Feiertag', at(3, 0), at(4, 0));
const inSix = event('Sitzung', at(6, 16), at(6, 17));
const allDay9 = event('Ferien', at(9, 0), at(12, 0));       // drei Tage
const in14 = event('Steuertermin', at(14, 10), at(14, 11));
const in20 = event('Reise', at(20, 8), at(20, 9));
const allDayRunning = event('Brückentag', at(0, 0), at(1, 0)); // läuft heute

const all = [in20, past, tomorrow, allDay9, running, allDay3, in14, later, inSix,
    finishedToday, allDayRunning];

// ---- isAllDay / isRunning -------------------------------------------------

ok(A.isAllDay(allDay3), 'isAllDay: Mitternacht bis Mitternacht');
ok(A.isAllDay(allDay9), 'isAllDay: mehrtägig ab Mitternacht');
ok(!A.isAllDay(later), 'isAllDay: 18:00–19:30 ist kein Ganztagstermin');
ok(!A.isAllDay(event('X', at(0, 0), at(0, 0, 30))), 'isAllDay: 00:00–00:30 ist kein Ganztagstermin');
ok(!A.isAllDay(event('Y', at(0, 0), at(1, 10))), 'isAllDay: Mitternacht bis 10 Uhr ist kein Ganztagstermin');

ok(A.isRunning(running, now), 'isRunning: laufender Termin');
ok(!A.isRunning(later, now), 'isRunning: späterer Termin');
ok(!A.isRunning(finishedToday, now), 'isRunning: beendeter Termin');
ok(A.isRunning(allDayRunning, now), 'isRunning: laufender Ganztagstermin');

// ---- id-Zerlegung ---------------------------------------------------------

const withUid = {id: 'aaaa\nbbbb\n20261024T120000Z', date: at(0, 9), end: at(0, 10), summary: 'x'};
eq(A.sourceUidOf(withUid), 'aaaa', 'sourceUidOf: erster Teil der id');
eq(A.eventUidOf(withUid), 'bbbb', 'eventUidOf: zweiter Teil der id');
eq(A.sourceUidOf({date: at(0, 9), end: at(0, 10)}), '', 'sourceUidOf: ohne id leer');

// ---- formatWhen (Steffens Vorlage) ----------------------------------------

const strings = {allDay: 'Ganztag'};
const pad = n => String(n).padStart(2, '0');
const timeOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// Festes Deutsch statt Locale, damit der Test überall dasselbe prüft.
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
    'August', 'September', 'Oktober', 'November', 'Dezember'];
const dayFull = d => `${WEEKDAYS[d.getDay()]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
const weekday = d => WEEKDAYS[d.getDay()];
const when = (ev, extra = {}) =>
    A.formatWhen(ev, now, {strings, timeOf, dayFull, weekday, ...extra});

eq(when(running), 'So, 20. September, 14:00 - 15:30',
    'formatWhen: laufender Termin mit Datum und Zeitspanne');
eq(when(later), 'So, 20. September, 18:00 - 19:30', 'formatWhen: späterer Termin');
eq(when(tomorrow), 'Mo, 21. September, 09:00 - 10:30',
    'formatWhen: morgiger Termin trägt sein eigenes Datum');
eq(when(allDay3), 'Mi, 23. September, Ganztag', 'formatWhen: eintägig ganztägig');
eq(when(allDay9), 'Di, 29. September - Do, 1. Oktober',
    'formatWhen: mehrtägig ganztägig als Datumsspanne');

const overnight = event('Nachtschicht', at(0, 22), at(1, 2));
eq(when(overnight), 'So, 20. September, 22:00 - Mo, 02:00',
    'formatWhen: mehrtägig mit Uhrzeit, kurze Endangabe (Wochentag)');

const overMonth = event('Reise', new Date(2026, 8, 30, 14, 0), new Date(2026, 9, 2, 12, 0));
eq(when(overMonth), 'Mi, 30. September, 14:00 - Fr, 2. Oktober, 12:00',
    'formatWhen: über Monatsgrenze mit vollem Enddatum');

eq(A.defaultTimeOf(at(0, 8, 5)), '08:05', 'defaultTimeOf: HH:MM');
ok(/^\w+, \d+\. \w+$/.test(A.defaultDayFull(at(5, 12))),
    'defaultDayFull: Wochentag, Tag. Monat', A.defaultDayFull(at(5, 12)));
ok(/^\w{2}$/.test(A.defaultWeekday(at(5, 12))),
    'defaultWeekday: zwei Buchstaben', A.defaultWeekday(at(5, 12)));

// ---- selectAppointments ---------------------------------------------------

const withPast = A.selectAppointments(all, now, {count: 6, showAllDay: true, showPast: true});
eq(withPast.bright.map(e => e.summary).join(','),
    'Brückentag,Heute später,Morgen früh,Feiertag,Sitzung,Ferien',
    'bright: die nächsten sechs, chronologisch, laufender Ganztagstermin zuerst (00:00)');
eq(withPast.past.map(e => e.summary).join(','), 'Vergangen,Heute früh',
    'past: zwei beendete, ältester zuerst');
eq(withPast.running.map(e => e.summary).join(','), 'Läuft gerade',
    'running: nur der gerade laufende terminierte Termin');
ok(!withPast.past.includes(allDayRunning), 'past: laufender Ganztagstermin gehört nicht dazu');
ok(withPast.bright.includes(allDayRunning), 'bright: laufender Ganztagstermin steht in der hellen Liste');

const onlyOnePast = A.selectAppointments(all, now, {pastCount: 1, showPast: true});
eq(onlyOnePast.past.map(e => e.summary).join(','), 'Heute früh',
    'past: nur ein vergangener, wenn pastCount = 1');

const noPast = A.selectAppointments(all, now, {count: 6, showPast: false});
eq(noPast.past.length + noPast.running.length, 0, 'showPast=false: kein gedimmter Block');
ok(noPast.bright.some(e => e.summary === 'Läuft gerade'),
    'showPast=false: der laufende Termin rutscht in die helle Liste');
eq(noPast.bright.length, 6, 'showPast=false: weiterhin sechs Einträge');

const withoutAllDay = A.selectAppointments(all, now, {count: 6, showAllDay: false, showPast: true});
eq(withoutAllDay.bright.map(e => e.summary).join(','),
    'Heute später,Morgen früh,Sitzung,Steuertermin,Reise',
    'showAllDay=false: Ganztagstermine fallen aus der hellen Liste');

const empty = A.selectAppointments([], now, {});
ok(empty.past.length + empty.running.length + empty.bright.length === 0,
    'leere Eingabe bleibt leer');

const endingNow = event('Endet jetzt', at(0, 13, 30), now);
const assigned = A.selectAppointments([endingNow], now, {});
eq(assigned.past.length, 1, 'genau jetzt endender Termin zählt als beendet');
eq(assigned.past.length + assigned.running.length + assigned.bright.length, 1,
    'kein Termin geht bei der Aufteilung verloren');

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
System.exit(failures > 0 ? 1 : 0);
