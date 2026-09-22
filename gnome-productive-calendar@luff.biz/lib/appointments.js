// Reine Terminlogik: keine Shell-Abhängigkeiten, keine Oberfläche. Mit einfachem
// gjs testbar (siehe test/appointments.test.mjs).
//
// Die Shell liefert CalendarEvent-artige Objekte ({id, date, end, summary}).
// Die id ist dreiteilig: "<Quell-UID>\n<Termin-UID>\n<Vorkommens-Stempel>".
// Zusätzlich hineingereicht werden Kalendername (aus der Quell-UID) und Ort
// (aus ECal) — beides wird hier nur eingesetzt, nicht beschafft.

import GLib from 'gi://GLib';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

/** Ganztägige Termine kommen als Spannen von Mitternacht zu Mitternacht. */
export function isAllDay(event) {
    const start = event.date;
    const end = event.end;
    if (start.getHours() !== 0 || start.getMinutes() !== 0)
        return false;
    if (end.getHours() !== 0 || end.getMinutes() !== 0)
        return false;
    return end - start >= DAY_MS;
}

export function isRunning(event, now) {
    return event.date <= now && now < event.end;
}

/** 24-Stunden-Notnagel; die Shell reicht ihren eigenen Formatierer herein. */
export function defaultTimeOf(date) {
    return GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1,
        date.getDate(), date.getHours(), date.getMinutes(), 0).format('%H:%M');
}

/** Wochentag und Datum, z. B. "Mi, 22. September" */
export function defaultDayFull(date) {
    const dt = GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1,
        date.getDate(), 0, 0, 0);
    return `${dt.format('%a')}, ${date.getDate()}. ${dt.format('%B')}`;
}

/** Nur der Wochentag, z. B. "Do" */
export function defaultWeekday(date) {
    return GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1,
        date.getDate(), 0, 0, 0).format('%a');
}

/**
 * Zweite Zeile eines Eintrags:
 *
 *   eintägig, mit Uhrzeit    Mi, 22. September, 10:00 - 22:00 Uhr
 *   eintägig, ganztägig      Mi, 22. September, Ganztag
 *   mehrtägig, ganztägig     Mi, 22. September - Do, 24. September
 *   mehrtägig, mit Uhrzeit   Mi, 22. September, 14:00 - Do, 12:00 Uhr
 *                            (über einen Monatswechsel: … - Sa, 2. Oktober, 12:00 Uhr)
 *
 * `strings` = {allDay, clock}
 */
export function formatWhen(event, now, {
    strings,
    timeOf = defaultTimeOf,
    dayFull = defaultDayFull,
    weekday = defaultWeekday,
} = {}) {
    // Letzter Tag, den der Termin berührt — deshalb eine Millisekunde vor dem Ende.
    const firstDay = startOfDay(event.date);
    const lastDay = startOfDay(new Date(event.end.getTime() - 1));
    const spansDays = lastDay.getTime() > firstDay.getTime();

    if (isAllDay(event)) {
        return spansDays
            ? `${dayFull(event.date)} - ${dayFull(lastDay)}`
            : `${dayFull(event.date)}, ${strings.allDay}`;
    }

    const endTime = timeOf(event.end);
    if (!spansDays)
        return `${dayFull(event.date)}, ${timeOf(event.date)} - ${endTime} ${strings.clock}`;

    // Kurze Endangabe: nur der Wochentag, solange der Monat derselbe ist.
    const endLabel = lastDay.getMonth() === firstDay.getMonth()
        ? weekday(lastDay)
        : dayFull(lastDay);
    return `${dayFull(event.date)}, ${timeOf(event.date)} - ${endLabel}, ` +
        `${endTime} ${strings.clock}`;
}

/** Quell-UID eines Termins (erster Teil der id). */
export function sourceUidOf(event) {
    return event.id?.split('\n')[0] ?? '';
}

/** Termin-UID (zweiter Teil der id) — Schlüssel für `gnome-calendar -u`. */
export function eventUidOf(event) {
    return event.id?.split('\n')[1] ?? '';
}

function byStart(a, b) {
    return a.date - b.date || a.end - b.end || (a.summary ?? '').localeCompare(b.summary ?? '');
}

/**
 * Teilt die Termine in drei Listen:
 *   past    — die letzten `pastCount` beendeten, ältester zuerst
 *   running — was gerade läuft (nur terminierte; ein laufender Ganztagstermin
 *             ist nichts "Verpasstes" und bleibt bei den kommenden)
 *   bright  — was noch kommt, chronologisch, auf `count` begrenzt
 *
 * Ohne den gedimmten Block (showPast = false) muss ein gerade laufender Termin
 * in die helle Liste, sonst verschwindet er lautlos.
 */
export function selectAppointments(events, now, {
    count = 6,
    showAllDay = true,
    showPast = true,
    pastCount = 2,
} = {}) {
    const visible = events.filter(event => showAllDay || !isAllDay(event));
    const timedRunning = visible
        .filter(event => !isAllDay(event) && isRunning(event, now))
        .sort(byStart);
    const future = visible
        .filter(event => event.end > now && !timedRunning.includes(event))
        .sort(byStart);

    if (!showPast)
        return {
            past: [],
            running: [],
            bright: [...timedRunning, ...future].sort(byStart).slice(0, count),
        };

    const finished = visible
        .filter(event => !isAllDay(event) && event.end <= now)
        .sort((a, b) => b.end - a.end)
        .slice(0, pastCount)
        .reverse();

    return {past: finished, running: timedRunning, bright: future.slice(0, count)};
}

/**
 * Ein ruhiger Zeitraum darf die Liste nicht abschneiden: Fenster verdoppeln,
 * bis zur harten Obergrenze. Unverändert zurückgeben, wenn nichts wachsen muss.
 */
export function widenedWindow(days, found, count, maxDays) {
    if (found >= count || days >= maxDays)
        return days;
    return Math.min(maxDays, days * 2);
}
