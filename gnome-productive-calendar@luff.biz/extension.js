// Productive Calendar — zeigt die nächsten Termine im Datumsmenü von GNOME
// anstelle einer Liste, die immer nur den gewählten Tag kennt.
//
// Zwei Quellen, bewusst getrennt:
//   * org.gnome.Shell.CalendarServer (D-Bus) — Termine: Titel, Start, Ende, id.
//     Dieselbe Schnittstelle, die das eingebaute Datumsmenü benutzt; sie kennt
//     jeden Kalender, den Evolution Data Server verwaltet.
//   * ECal/EDS — Kalendername über die Quellenregistrierung von EDS. Der Ort
//     wird derzeit nicht angezeigt; die Abfrage dafür ist ausgebaut.
//     Beides sind GNOME-Standardbibliotheken, keine Zusatzinstallation.
//
// Die Auswahl- und Formatierlogik liegt in lib/appointments.js (ohne
// Shell-Abhängigkeiten, eigens getestet).

import EDataServer from 'gi://EDataServer?version=1.2';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {eventUidOf, formatWhen, isSameDay, selectAppointments, sourceUidOf, widenedWindow}
    from './lib/appointments.js';

const MAX_LOOKAHEAD_DAYS = 730; // harte Obergrenze beim Vergrößern des Fensters
// Der Cache der Terminquelle füllt asynchron — eine leere Liste in den ersten
// Millisekunden bedeutet nichts. Erst danach wird vergrößert.
const WIDEN_AFTER_US = 5 * 1000 * 1000;
const PAST_COUNT = 2; // fest: zwei vergangene Termine
// Deckkraft: 0–255, direkt am Widget gesetzt (CSS `opacity` greift in St nicht).
const PAST_OPACITY = 128;    // 50 %
const RUNNING_OPACITY = 191; // 75 %
// Das Zeitfenster muss auch in die Vergangenheit reichen, sonst kann der
// gedimmte Block nie gefüllt werden.
const PAST_WINDOW_DAYS = 7;

const CALENDAR_APP_ID = 'org.gnome.Calendar.desktop';
const SERVER_BUS_NAME = 'org.gnome.Shell.CalendarServer';
const SERVER_PATH = '/org/gnome/Shell/CalendarServer';
const SERVER_IFACE = 'org.gnome.Shell.CalendarServer';

const SETTINGS_KEYS = [
    'event-count',
    'lookahead-days',
    'show-all-day',
    'show-past',
    'hide-calendar-grid',
    'debug-logging',
];

/**
 * Der Abschnitt, der die native Tagesliste ersetzt.
 * Drei Zeilen je Eintrag: Titel fett, Zeitspanne bzw. "Ganztag" mit Ort,
 * darunter klein der Kalendername. Reine Anzeige, kein Klickziel.
 */
class UpcomingSection {
    constructor({formatEvent, onActivate}) {
        this._formatEvent = formatEvent;
        this._onActivate = onActivate;
        // Der Abschnitt selbst ist keine Schaltfläche mehr — die Zeilen sind es.
        this._actor = new St.BoxLayout({
            style_class: 'events-box productive-calendar-section',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._list = new St.BoxLayout({
            style_class: 'events-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._actor.add_child(this._list);
        // Merkt sich den Abbau: Nach dem Zerstören darf nichts mehr anfassen.
        this._disposed = false;
        this._actor.connect('destroy', () => {
            this._disposed = true;
        });
    }

    get actor() {
        return this._actor;
    }

    get disposed() {
        return this._disposed;
    }

    /** Die fertige zweite Zeile eines Eintrags — auch für die Protokollierung. */
    formatLineFor(event, now) {
        return this._formatEvent(event, now).when;
    }

    /**
     * Reihenfolge: erst die zwei vergangenen (gedimmt), dann — wenn vorhanden —
     * die laufenden mit eigener Überschrift, dann mit Überschrift die kommenden.
     * Ganz oben steht keine Überschrift.
     */
    setEvents({past, running, bright}, now) {
        if (this._disposed)
            return;

        for (const child of this._list.get_children())
            child.destroy();

        if (past.length + running.length + bright.length === 0) {
            this._list.add_child(new St.Label({
                text: _('Nichts geplant'),
                style_class: 'event-placeholder',
            }));
            return;
        }

        for (const event of past)
            this._list.add_child(this._makeRow(event, now, PAST_OPACITY));

        if (running.length > 0) {
            this._list.add_child(this._heading(_('Laufende Termine')));
            for (const event of running)
                this._list.add_child(this._makeRow(event, now, RUNNING_OPACITY));
        }

        const upcoming = bright.length === 0
            ? _('Nächste Termine')
            : (bright.length === 1
                ? _('Nächster Termin')
                : _('Nächste %d Termine').format(bright.length));
        this._list.add_child(this._heading(upcoming));

        for (const event of bright)
            this._list.add_child(this._makeRow(event, now, 255));
    }

    _heading(text) {
        return new St.Label({
            style_class: 'events-title productive-calendar-heading',
            text,
        });
    }

    _makeRow(event, now, opacity) {
        const line = this._formatEvent(event, now);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(this._label('event-summary', event.summary || _('Ohne Titel')));
        box.add_child(this._label('event-time', line.when));

        if (line.calendar) {
            const name = this._label('productive-calendar-calendar', line.calendar);
            name.opacity = 178; // zurückgenommen; die Zeile dimmt zusätzlich
            box.add_child(name);
        }

        // Jede Zeile ist eine eigene Schaltfläche. `popup-menu-item` ist die
        // Standard-Klasse der Shell für Hover in Popups: Hintergrund, Radius
        // und Abstände kommen vom Theme — keine Eigenfarbe.
        const row = new St.Button({
            style_class: 'popup-menu-item productive-calendar-row',
            x_expand: true,
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: box,
        });
        row.opacity = opacity;
        row.connect('clicked', () => this._onActivate?.(event));
        return row;
    }

    _label(styleClass, text) {
        const label = new St.Label({style_class: styleClass, text, x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }
}

export default class ProductiveCalendarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeoutId = 0;
        this._assertTimeoutId = 0;
        this._lookaheadDays = 0;
        this._enabledAt = GLib.get_monotonic_time();
        this._selectedDate = new Date();

        this._calendarNames = new Map();
        // Merkt sich je Kanal die zuletzt protokollierte Aussage, damit
        // unveränderte Zustände nicht wiederholt ins Journal wandern.
        this._logged = new Map();

        this._dateMenu = Main.panel.statusArea.dateMenu ?? null;
        this._nativeEvents = this._dateMenu?._eventsItem ?? null;
        // Der Container wird gemerkt: der native Abschnitt wird ja gerade
        // ausgehängt, sein get_parent() wäre danach null.
        this._containerBox = this._nativeEvents?.get_parent() ?? null;

        if (!this._nativeEvents || !this._containerBox) {
            log('[productive-calendar] Terminabschnitt im Datumsmenü nicht gefunden — nichts geändert');
            this._dateMenu = null;
            this._nativeEvents = null;
            this._containerBox = null;
            return;
        }

        this._strings = {
            allDay: _('Ganztag'),
            clock: _('Uhr'),
        };

        this._loadCalendarNames();

        this._eventSource = new Calendar.DBusEventSource();
        this._eventSource.connectObject('changed', () => this._rebuild(), this);
        this._eventSource.connectObject('notify::has-calendars', () => this._syncVisibility(), this);

        this._section = new UpcomingSection({
            formatEvent: (event, now) => ({
                when: formatWhen(event, now, {
                    strings: this._strings,
                    timeOf: formatTime,
                }),
                calendar: this._calendarNames.get(sourceUidOf(event)) ?? null,
            }),
            onActivate: event => this._openInCalendar(event),
        });

        this._openStateId = this._dateMenu.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                return;
            this._lookaheadDays = 0; // wieder vom eingestellten Fenster ausgehen
            this._queueRebuild(150);
            // Das Monatsgitter setzt beim Öffnen den gemeinsamen Zeitraum neu;
            // unseren danach erneut setzen, damit künftige Termine weiterlaufen.
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
        this._debug('state', 'enabled', 'enabled');
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
            this._attach(this._nativeEvents); // native Tagesliste zurückgeben
        }

        if (this._dateMenu?._calendar)
            this._dateMenu._calendar.visible = true;

        if (this._eventSource) {
            this._eventSource.disconnectObject(this);
            this._eventSource.destroy();
            this._eventSource = null;
        }

        this._calendarNames?.clear();
        this._calendarNames = new Map();

        this._settings = null;
        this._dateMenu = null;
        this._nativeEvents = null;
        this._containerBox = null;
    }

    // ---- Platzierung ------------------------------------------------------

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
     * Unser Abschnitt steht anstelle der nativen Tagesliste — aber nur, solange
     * diese nichts beizutragen hat: heute gewählt, Kalender vorhanden, Termine
     * im Sitzungsmodus erlaubt. Beim Blättern auf einen anderen Tag übernimmt
     * wieder die native Liste.
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

        const container = this._describeContainer();
        this._debug('placement', `${useNative ? 'native' : 'ours'}|${container}`,
            `placing ${useNative ? 'native day list' : 'upcoming list'} ` +
            `(showEvents=${showEvents}, hasCalendars=${hasCalendars}, ` +
            `browsingOtherDay=${browsingOtherDay}) container=[${container}]`);
    }

    /** Welche Abschnitte gerade tatsächlich in der Box liegen. */
    _describeContainer() {
        if (!this._containerBox)
            return 'gone';
        return this._containerBox.get_children()
            .map(child => child.style_class || child.constructor.name)
            .join(', ');
    }

    // ---- Daten: Termine über D-Bus ----------------------------------------

    _range(days) {
        const now = new Date();
        return [
            new Date(now.getTime() - PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000),
            new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
        ];
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
     * Der Zeitraum ist globaler Zustand auf dem Bus und wird mit dem Monatsgitter
     * geteilt: wer zuletzt SetTimeRange ruft, gewinnt. Also selbst nachfassen.
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
                        logError(e, '[productive-calendar] SetTimeRange fehlgeschlagen');
                    }
                });
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        if (!this._section || this._section.disposed || !this._eventSource)
            return;

        const now = new Date();
        const wanted = Math.max(1, this._settings.get_int('event-count'));
        const showAllDay = this._settings.get_boolean('show-all-day');
        const showPast = this._settings.get_boolean('show-past');
        const days = this._days();
        const [begin, end] = this._range(days);

        let events = [];
        try {
            events = this._eventSource.getEvents(begin, end);
        } catch (e) {
            logError(e, '[productive-calendar] Termine nicht lesbar');
            return;
        }

        const {past, running, bright} = selectAppointments(events, now, {
            count: wanted,
            showAllDay,
            showPast,
            pastCount: PAST_COUNT,
        });
        this._section.setEvents({past, running, bright}, now);

        const wider = GLib.get_monotonic_time() - this._enabledAt > WIDEN_AFTER_US
            ? widenedWindow(days, bright.length, wanted, MAX_LOOKAHEAD_DAYS)
            : days;
        if (wider !== days) {
            this._lookaheadDays = wider;
            this._queueRangeAssert(0);
        }

        const rendered = [
            ...past.map(e => `(${e.summary})`),
            ...running.map(e => `{${e.summary}}`),
            ...bright.map(e => e.summary),
        ];
        // Nur die sichtbare Liste entscheidet, ob das eine neue Aussage ist —
        // ein größer gewordenes Zeitfenster allein ist keine.
        this._debug('render', rendered.join(' | '),
            `render ${bright.length}/${wanted} hell, ${past.length} vergangen, ` +
            `${running.length} laufend (window ${days}d, ${events.length} Termine bekannt): ` +
            rendered.join(' | '));

        if (bright.length > 0) {
            const sample = this._section.formatLineFor(bright[0], now);
            this._debug('sample', sample, `Beispielzeile: ${sample}`);
        }
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

    // ---- Daten: Kalendernamen über EDS ------------------------------------

    _loadCalendarNames() {
        try {
            const registry = EDataServer.SourceRegistry.new_sync(null);
            for (const source of registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)) {
                if (!source.get_enabled())
                    continue;
                this._calendarNames.set(source.get_uid(), source.get_display_name());
            }
        } catch (e) {
            logError(e, '[productive-calendar] Kalendernamen nicht lesbar');
        }

        const names = [...this._calendarNames.values()].join(', ');
        this._debug('calendars', names, `Kalender: ${names}`);
    }

    // ---- Einstellungen ----------------------------------------------------

    _onSettingsChanged() {
        this._lookaheadDays = 0;
        // Nach einer Einstellungsänderung soll der nächste Zustand wieder
        // protokolliert werden, auch wenn er schon einmal dastand.
        this._logged.clear();
        this._applySettings();
        this._requestRange();
        this._queueRebuild(0);
    }

    _applySettings() {
        if (this._dateMenu?._calendar)
            this._dateMenu._calendar.visible = !this._settings.get_boolean('hide-calendar-grid');
    }

    /** Klick auf eine Zeile: den Termin direkt in GNOME Kalender öffnen. */
    _openInCalendar(event) {
        const uid = eventUidOf(event);
        if (!uid)
            return;

        const app = Shell.AppSystem.get_default().lookup_app(CALENDAR_APP_ID);
        if (!app) {
            log('[productive-calendar] GNOME Calendar nicht gefunden');
            return;
        }

        Main.panel.closeCalendar();
        const context = global.create_app_launch_context(0, -1);
        app.launch(['-u', uid], context);
    }

    /**
     * Schreibt nur, wenn sich die Aussage eines Kanals geändert hat.
     * Sonst würde jeder Aufbau dieselben Zeilen wiederholen.
     */
    _debug(channel, key, message) {
        if (!this._settings?.get_boolean('debug-logging'))
            return;
        if (this._logged?.get(channel) === key)
            return;
        this._logged?.set(channel, key);
        log(`[productive-calendar] ${message}`);
    }
}
