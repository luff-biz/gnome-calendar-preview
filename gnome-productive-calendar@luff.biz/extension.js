// Productive Calendar — shows the next N appointments in the GNOME date menu
// instead of a list that only ever covers the selected day.
//
// Data source: the shell's own org.gnome.Shell.CalendarServer via
// resource:///org/gnome/shell/ui/calendar.js (DBusEventSource). No polling —
// the server pushes EventsAddedOrUpdated / EventsRemoved.
//
// The selection and formatting logic lives in lib/appointments.js, which has no
// shell dependencies and is unit-tested separately.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatWhen, isSameDay, upcomingEvents, widenedWindow} from './lib/appointments.js';

const MAX_LOOKAHEAD_DAYS = 730; // hard upper bound when widening to fill the list
// The event source fills its cache asynchronously, so an empty list right after
// enabling means nothing. Only start widening once that has settled.
const WIDEN_AFTER_US = 5 * 1000 * 1000;

const CALENDAR_APP_ID = 'org.gnome.Calendar.desktop';
const SERVER_BUS_NAME = 'org.gnome.Shell.CalendarServer';
const SERVER_PATH = '/org/gnome/Shell/CalendarServer';
const SERVER_IFACE = 'org.gnome.Shell.CalendarServer';

const SETTINGS_KEYS = [
    'event-count',
    'lookahead-days',
    'show-all-day',
    'open-calendar-on-click',
    'hide-calendar-grid',
    'debug-logging',
];

/**
 * The list widget that takes the place of the native events section.
 * Built from plain widgets; shell internals are only touched where it has to be
 * inserted.
 */
class UpcomingSection {
    constructor({onActivate, formatEvent}) {
        this._formatEvent = formatEvent;
        this._button = new St.Button({
            style_class: 'events-button productive-calendar-section',
            can_focus: true,
            x_expand: true,
        });
        this._box = new St.BoxLayout({
            style_class: 'events-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._title = new St.Label({style_class: 'events-title'});
        this._list = new St.BoxLayout({
            style_class: 'events-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._box.add_child(this._title);
        this._box.add_child(this._list);
        this._button.set_child(this._box);
        this._button.connect('clicked', onActivate);
    }

    get actor() {
        return this._button;
    }

    setClickable(clickable) {
        this._button.reactive = clickable;
        this._button.can_focus = clickable;
    }

    setEvents(events, now) {
        for (const child of this._list.get_children())
            child.destroy();

        const count = events.length;
        const title = ngettext('Next appointment', 'Next %d appointments', count);
        this._title.text = count === 0
            ? _('Upcoming appointments')
            : (count === 1 ? title : title.format(count));

        if (count === 0) {
            this._list.add_child(new St.Label({
                text: _('Nothing scheduled'),
                style_class: 'event-placeholder',
            }));
            return;
        }

        for (const event of events)
            this._list.add_child(this._makeRow(event, now));
    }

    _makeRow(event, now) {
        const row = new St.BoxLayout({
            style_class: 'productive-calendar-row',
            x_expand: true,
        });
        if (event.date <= now && now < event.end)
            row.add_style_class_name('productive-calendar-running');

        const summary = new St.Label({
            style_class: 'event-summary',
            text: event.summary || _('Untitled'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const when = new St.Label({
            style_class: 'event-time',
            text: this._formatEvent(event, now),
            y_align: Clutter.ActorAlign.CENTER,
        });

        row.add_child(summary);
        row.add_child(when);
        return row;
    }
}

export default class ProductiveCalendarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeoutId = 0;
        this._assertTimeoutId = 0;
        this._lookaheadDays = 0;
        this._selectedDate = new Date();
        this._enabledAt = GLib.get_monotonic_time();

        this._dateMenu = Main.panel.statusArea.dateMenu ?? null;
        this._nativeEvents = this._dateMenu?._eventsItem ?? null;
        // The native section's parent — cached, because that is exactly what gets
        // detached while our list takes its place. Deriving it from
        // _nativeEvents.get_parent() would yield null after the first swap.
        this._containerBox = this._nativeEvents?.get_parent() ?? null;

        if (!this._nativeEvents || !this._containerBox) {
            // No date menu in this session mode, or shell internals changed.
            log('[productive-calendar] date menu events section not found — nothing patched');
            this._dateMenu = null;
            this._nativeEvents = null;
            this._containerBox = null;
            return;
        }

        this._strings = {
            today: _('Today'),
            tomorrow: _('Tomorrow'),
            allDay: _('all day'),
            nowUntil: _('now–%s'),
        };

        this._eventSource = new Calendar.DBusEventSource();
        this._eventSource.connectObject('changed', () => this._rebuild(), this);
        this._eventSource.connectObject('notify::has-calendars', () => this._syncVisibility(), this);

        this._section = new UpcomingSection({
            onActivate: () => this._activateCalendar(),
            formatEvent: (event, now) => formatWhen(event, now, this._strings, formatTime),
        });

        this._openStateId = this._dateMenu.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                return;
            this._lookaheadDays = 0; // start from the configured window again
            this._queueRebuild(150);
            // The month grid re-sets the shared time range when the menu opens;
            // re-assert ours a moment later so future events keep arriving.
            this._queueRangeAssert(250);
        });

        this._selectedDateId = this._dateMenu._calendar?.connect('selected-date-changed',
            (_calendar, datetime) => {
                this._selectedDate = new Date(datetime.get_year(),
                    datetime.get_month() - 1, datetime.get_day_of_month());
                this._syncVisibility();
            }) ?? 0;

        this._settingsIds = SETTINGS_KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingsChanged()));

        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncVisibility());

        this._requestRange();
        this._applySettings();
        this._syncVisibility();
        this._debug('enabled');
        this._rebuild();
    }

    disable() {
        this._cancelTimeout();
        this._cancelAssertTimeout();

        this._settingsIds?.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        if (this._selectedDateId && this._dateMenu?._calendar) {
            this._dateMenu._calendar.disconnect(this._selectedDateId);
            this._selectedDateId = 0;
        }

        if (this._openStateId && this._dateMenu?.menu) {
            this._dateMenu.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }

        if (this._section) {
            this._detach(this._section.actor);
            this._section.actor.destroy();
            this._section = null;
        }

        if (this._nativeEvents) {
            this._detach(this._nativeEvents);
            this._attach(this._nativeEvents); // give the native day list back
        }

        if (this._dateMenu?._calendar)
            this._dateMenu._calendar.visible = true;

        if (this._eventSource) {
            this._eventSource.disconnectObject(this);
            this._eventSource.destroy();
            this._eventSource = null;
        }

        this._settings = null;
        this._dateMenu = null;
        this._nativeEvents = null;
        this._containerBox = null;
    }

    // ---- placement -------------------------------------------------------

    _attach(actor) {
        const parent = this._containerBox;
        if (!parent || actor.get_parent() === parent)
            return;
        parent.insert_child_at_index(actor, 0);
    }

    _detach(actor) {
        const parent = actor.get_parent();
        if (parent)
            parent.remove_child(actor);
    }

    /**
     * Ours instead of the native day list — but only while the native list has
     * nothing to add: today is selected, calendars exist, and events are shown
     * in this session mode. Browsing another day falls back to the native list.
     */
    _syncVisibility() {
        if (!this._section || !this._nativeEvents)
            return;

        const showEvents = Main.sessionMode.showCalendarEvents !== false;
        const hasCalendars = this._eventSource?.hasCalendars === true;
        const browsingOtherDay = !isSameDay(this._selectedDate, new Date());
        const useNative = !showEvents || !hasCalendars || browsingOtherDay;

        if (useNative) {
            this._detach(this._section.actor);
            this._attach(this._nativeEvents);
        } else {
            this._detach(this._nativeEvents);
            this._attach(this._section.actor);
        }

        this._debug(`placing ${useNative ? 'native day list' : 'upcoming list'} ` +
            `(showEvents=${showEvents}, hasCalendars=${hasCalendars}, ` +
            `browsingOtherDay=${browsingOtherDay}) ` +
            `container=[${this._describeContainer()}]`);
    }

    /** Which sections actually sit in the displays box right now. */
    _describeContainer() {
        if (!this._containerBox)
            return 'gone';
        return this._containerBox.get_children()
            .map(child => child.style_class || child.constructor.name)
            .join(', ');
    }

    // ---- data ------------------------------------------------------------

    _range(days) {
        const now = new Date();
        return [now, new Date(now.getTime() + days * 24 * 60 * 60 * 1000)];
    }

    _configuredDays() {
        return Math.min(MAX_LOOKAHEAD_DAYS,
            Math.max(1, this._settings.get_int('lookahead-days')));
    }

    _days() {
        if (!this._lookaheadDays)
            this._lookaheadDays = this._configuredDays();
        return this._lookaheadDays;
    }

    _requestRange() {
        const [begin, end] = this._range(this._days());
        this._eventSource?.requestRange(begin, end);
    }

    /**
     * The time range is global state on the bus, shared with the month grid:
     * whoever calls SetTimeRange last wins. So re-assert ours directly.
     */
    _queueRangeAssert(delayMs) {
        this._cancelAssertTimeout();
        this._assertTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._assertTimeoutId = 0;
            const [begin, end] = this._range(this._days());
            Gio.DBus.session.call(
                SERVER_BUS_NAME, SERVER_PATH, SERVER_IFACE, 'SetTimeRange',
                new GLib.Variant('(xxb)', [
                    Math.floor(begin.getTime() / 1000),
                    Math.floor(end.getTime() / 1000),
                    false,
                ]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch (e) {
                        logError(e, '[productive-calendar] SetTimeRange failed');
                    }
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        if (!this._section || !this._eventSource)
            return;

        const now = new Date();
        const wanted = Math.max(1, this._settings.get_int('event-count'));
        const showAllDay = this._settings.get_boolean('show-all-day');
        const days = this._days();
        const [begin, end] = this._range(days);

        let events = [];
        try {
            events = this._eventSource.getEvents(begin, end);
        } catch (e) {
            logError(e, '[productive-calendar] could not read events');
            return;
        }

        const upcoming = upcomingEvents(events, now, {count: wanted, showAllDay});
        this._section.setEvents(upcoming, now);
        this._section.setClickable(this._settings.get_boolean('open-calendar-on-click'));

        const settled = GLib.get_monotonic_time() - this._enabledAt > WIDEN_AFTER_US;
        const wider = settled
            ? widenedWindow(days, upcoming.length, wanted, MAX_LOOKAHEAD_DAYS)
            : days;
        if (wider !== days) {
            this._lookaheadDays = wider;
            this._queueRangeAssert(0);
        }

        this._debug(`render ${upcoming.length}/${wanted} (window ${days}d, ` +
            `${events.length} events known): ` +
            upcoming.map(e => e.summary).join(' | '));
    }

    _queueRebuild(delayMs) {
        this._cancelTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timeoutId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimeout() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _cancelAssertTimeout() {
        if (this._assertTimeoutId) {
            GLib.Source.remove(this._assertTimeoutId);
            this._assertTimeoutId = 0;
        }
    }

    // ---- settings & activation -------------------------------------------

    _onSettingsChanged() {
        this._lookaheadDays = 0;
        this._applySettings();
        this._requestRange();
        this._queueRebuild(0);
    }

    _applySettings() {
        if (this._dateMenu?._calendar)
            this._dateMenu._calendar.visible = !this._settings.get_boolean('hide-calendar-grid');
        this._section?.setClickable(this._settings.get_boolean('open-calendar-on-click'));
    }

    _activateCalendar() {
        if (!this._settings.get_boolean('open-calendar-on-click'))
            return;

        this._dateMenu?.menu.close();
        const app = Shell.AppSystem.get_default().lookup_app(CALENDAR_APP_ID);
        if (app)
            app.open_new_window(-1);
        else
            log('[productive-calendar] GNOME Calendar not found');
    }

    _debug(message) {
        if (this._settings?.get_boolean('debug-logging'))
            log(`[productive-calendar] ${message}`);
    }
}
