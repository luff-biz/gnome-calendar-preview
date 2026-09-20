// Pure appointment logic: no shell imports, no UI. Testable with plain gjs.
//
// The shell hands us CalendarEvent-like objects ({id, date, end, summary}) from
// DBusEventSource. Everything here works on those and on injected formatting
// dependencies, so the same code runs in the shell and in unit tests.

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

/** All-day appointments arrive as spans covering whole days (midnight to midnight). */
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

/** Whole days between the event's day and today; 0 = today, negative = past. */
export function dayIndex(date, now) {
    return Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
}

/** 24-hour fallback; the shell injects its own locale-aware formatter. */
export function defaultTimeOf(date) {
    return GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1,
        date.getDate(), date.getHours(), date.getMinutes(), 0).format('%H:%M');
}

export function dayLabel(date, now, strings, timeOf = defaultTimeOf) {
    const days = dayIndex(date, now);
    if (days <= 0)
        return strings.today;
    if (days === 1)
        return strings.tomorrow;
    return GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1,
        date.getDate(), 0, 0, 0).format('%a %d.%m.');
}

/**
 * Short "when" string for one appointment.
 * `strings` = {today, tomorrow, allDay, nowUntil} where nowUntil contains %s.
 */
export function formatWhen(event, now, strings, timeOf = defaultTimeOf) {
    const endTime = timeOf(event.end);

    if (isRunning(event, now))
        return strings.nowUntil.replace('%s', endTime);

    if (isAllDay(event))
        return `${dayLabel(event.date, now, strings, timeOf)} · ${strings.allDay}`;

    const times = `${timeOf(event.date)}–${endTime}`;
    if (isSameDay(event.date, now))
        return times;

    return `${dayLabel(event.date, now, strings, timeOf)} · ${times}`;
}

/**
 * The appointments to show: still relevant, optionally without all-day entries,
 * chronological, capped at `count`.
 */
export function upcomingEvents(events, now, {count = 6, showAllDay = true} = {}) {
    return events
        .filter(event => event.end > now)
        .filter(event => showAllDay || !isAllDay(event))
        .sort((a, b) => a.date - b.date || a.end - b.end || a.summary.localeCompare(b.summary))
        .slice(0, count);
}

/**
 * A quiet window must not truncate the list: double it, up to the hard bound.
 * Returns the current value unchanged when nothing needs to grow.
 */
export function widenedWindow(days, found, count, maxDays) {
    if (found >= count || days >= maxDays)
        return days;
    return Math.min(maxDays, days * 2);
}
