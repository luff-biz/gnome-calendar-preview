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

import ECal from 'gi://ECal?version=2.0';
import EDataServer from 'gi://EDataServer?version=1.2';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
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
// Termindetails (Ort, Beschreibung, Teilnehmer) höchstens alle 5 Minuten neu holen.
const DETAILS_RELOAD_US = 5 * 60 * 1000 * 1000;
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

/** Erster lesbarer Text aus einem ECal-Textfeld (z. B. Beschreibung). */
function textValue(text) {
    if (!text)
        return null;
    try {
        const value = text.get_value();
        if (value != null && String(value).trim())
            return String(value).trim();
    } catch (e) {
        // kein get_value
    }
    if (text.value != null && String(text.value).trim())
        return String(text.value).trim();
    return null;
}

/**
 * Beschriftung, die URLs anklickbar macht. Der Klick wird über eine
 * ClickGesture behandelt, die nur dann „erkennt", wenn der Klick auf einer URL
 * liegt — andernfalls geht der Klick an die Zeile (Button) und klappt zu.
 * Vorbild ist der URLHighlighter der GNOME-Shell (messageList.js).
 */
const LinkLabel = GObject.registerClass(
class LinkLabel extends St.Label {
    _init(text) {
        super._init({
            reactive: true,
            style_class: 'productive-calendar-field-value',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._linkColor = '#ccccff';
        this._urls = [];

        this.clutter_text.line_wrap = true;
        this.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.setMarkup(text);

        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connectObject(
            'recognize', this._onClick.bind(this),
            'may-recognize', this._checkInUrl.bind(this),
            this);
        this.add_action(this._clickGesture);
    }

    _checkInUrl() {
        const {x, y} = this._clickGesture.get_coords_abs();
        return this._findUrlAtPos(x, y) !== -1;
    }

    _onClick() {
        const {x, y} = this._clickGesture.get_coords_abs();
        const urlId = this._findUrlAtPos(x, y);
        if (urlId === -1)
            return;
        let url = this._urls[urlId].url;
        if (!url.includes(':'))
            url = `http://${url}`;
        Gio.app_info_launch_default_for_uri(
            url, global.create_app_launch_context(0, -1));
    }

    setMarkup(text) {
        this._text = text ? Util.fixMarkup(text, false) : '';
        this.clutter_text.set_markup(this._text);
        this._urls = Util.findUrls(this.clutter_text.text);
        this._highlightUrls();
    }

    _highlightUrls() {
        const urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (const url of urls) {
            markup += this._text.substring(pos, url.pos);
            markup += `<span foreground="${this._linkColor}"><u>${url.url}</u></span>`;
            pos = url.pos + url.url.length;
        }
        markup += this._text.substring(pos);
        this.clutter_text.set_markup(markup);
    }

    _findUrlAtPos(x, y) {
        [, x, y] = this.transform_stage_point(x, y);
        let findPos = -1;
        for (let i = 0; i < this.clutter_text.text.length; i++) {
            const [, px, py, lineHeight] = this.clutter_text.position_to_coords(i);
            if (py > y || py + lineHeight < y || x < px)
                continue;
            findPos = i;
        }
        if (findPos === -1)
            return -1;
        for (let i = 0; i < this._urls.length; i++) {
            if (findPos >= this._urls[i].pos &&
                this._urls[i].pos + this._urls[i].url.length > findPos)
                return i;
        }
        return -1;
    }
});

/**
 * Der Abschnitt, der die native Tagesliste ersetzt.
 * Drei Zeilen je Eintrag: Titel fett, Zeitspanne bzw. "Ganztag" mit Ort,
 * darunter klein der Kalendername. Reine Anzeige, kein Klickziel.
 */
class UpcomingSection {
    constructor({formatEvent, detailsFor}) {
        this._formatEvent = formatEvent;
        this._detailsFor = detailsFor;
        this._expandedEventId = null;
        this._rows = new Map();
        // Die Sektion ist ein schlichter Container (nur Einzug, siehe CSS),
        // die Zeilen sind die Karten: `events-button` liefert Padding, Radius,
        // Hintergrund und Hover.
        this._actor = new St.BoxLayout({
            style_class: 'productive-calendar-section',
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
        this._rows = new Map();

        if (past.length + running.length + bright.length === 0) {
            this._list.add_child(new St.Label({
                text: _('Nichts geplant'),
                style_class: 'event-placeholder',
            }));
            return;
        }

        const add = (event, opacity) => {
            const row = this._makeRow(event, now, opacity);
            this._list.add_child(row);
            this._rows.set(event.id, {row, event});
        };

        for (const event of past)
            add(event, PAST_OPACITY);

        if (running.length > 0) {
            this._list.add_child(this._heading(_('Laufende Termine')));
            for (const event of running)
                add(event, RUNNING_OPACITY);
        }

        const upcoming = bright.length === 0
            ? _('Nächste Termine')
            : (bright.length === 1
                ? _('Nächster Termin')
                : _('Nächste %d Termine').format(bright.length));
        this._list.add_child(this._heading(upcoming));

        for (const event of bright)
            add(event, 255);

        // Nach dem Neuaufbau wieder aufklappen, wenn vorher etwas offen war.
        if (this._expandedEventId && this._rows.has(this._expandedEventId)) {
            const {row, event} = this._rows.get(this._expandedEventId);
            this._appendDetails(row, event);
        }
    }

    _heading(text) {
        return new St.Label({
            style_class: 'events-title',
            text,
        });
    }

    _makeRow(event, now, opacity) {
        const line = this._formatEvent(event, now);

        const collapsed = new St.BoxLayout({
            style_class: 'productive-calendar-collapsed',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const summary = this._label('event-summary', event.summary || _('Ohne Titel'));
        const time = this._label('event-time', line.when);
        collapsed.add_child(summary);
        collapsed.add_child(time);

        let calendar = null;
        if (line.calendar) {
            calendar = this._label('productive-calendar-calendar', line.calendar);
            calendar.opacity = 178; // zurückgenommen; die Zeile dimmt zusätzlich
            collapsed.add_child(calendar);
        }

        // Behälter: die eingeklappte Zeile plus, bei Bedarf, der Detailblock.
        const container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        container.add_child(collapsed);

        // Jede Zeile ist eine eigene Karte (events-button): Klick klappt die
        // Details innerhalb der Zeile auf. Padding, Radius und Hover kommen
        // vom Theme, das horizontale Margin entfernen wir per CSS.
        const row = new St.Button({
            style_class: 'events-button productive-calendar-row',
            x_expand: true,
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: container,
        });
        row.opacity = opacity;
        row._container = container;
        row._detailsBox = null;
        row._collapsedLabels = [summary, time, calendar].filter(Boolean);
        row.connect('clicked', () => this._toggleExpansion(event, row));
        return row;
    }

    _field(caption, text) {
        const row = new St.BoxLayout({
            style_class: 'productive-calendar-field',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const captionLabel = new St.Label({
            style_class: 'productive-calendar-field-caption',
            text: caption,
        });
        captionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        row.add_child(captionLabel);
        // URLs im Wert sind anklickbar; der Klick auf eine URL öffnet sie,
        // jeder andere Klick geht an die Zeile und klappt zu.
        const value = new LinkLabel(text);
        row.add_child(value);
        return row;
    }

    /** Klick: Details innerhalb der Zeile auf- bzw. zuklappen. */
    _toggleExpansion(event, row) {
        if (this._expandedEventId === event.id) {
            this._expandedEventId = null;
            this._removeDetails(row);
            return;
        }

        // Nur eine Zeile gleichzeitig offen.
        if (this._expandedEventId && this._rows.has(this._expandedEventId)) {
            const previous = this._rows.get(this._expandedEventId);
            this._removeDetails(previous.row);
        }

        this._expandedEventId = event.id;
        this._appendDetails(row, event);
    }

    /** Die zusätzlichen Felder — nichts davon steht schon in der Zeile. */
    _appendDetails(row, event) {
        this._setExpanded(row, true);

        const details = this._detailsFor?.(event) ?? {};

        const box = new St.BoxLayout({
            style_class: 'productive-calendar-details',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        if (details.location)
            box.add_child(this._field(_('Ort'), details.location));

        if (details.description)
            box.add_child(this._field(_('Beschreibung'), details.description));

        if (details.attendees?.length)
            box.add_child(this._field(_('Teilnehmer'), details.attendees.join(', ')));

        // Auch ohne Felder sichtbar aufklappen statt stumm zu bleiben.
        if (box.get_n_children() === 0) {
            const empty = new St.Label({
                style_class: 'productive-calendar-field-value',
                text: _('Keine Details'),
            });
            empty.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            empty.opacity = 178;
            box.add_child(empty);
        }

        row._container.add_child(box);
        row._detailsBox = box;
    }

    _removeDetails(row) {
        if (row?._detailsBox) {
            row._detailsBox.destroy();
            row._detailsBox = null;
        }
        this._setExpanded(row, false);
    }

    /** Aufgeklappt bricht der Text um; eingeklappt wird gekürzt.
        Die Breite liefert die Karte über x_expand — keine Pixelrechnung. */
    _setExpanded(row, expanded) {
        for (const label of row?._collapsedLabels ?? []) {
            label.clutter_text.line_wrap = expanded;
            label.clutter_text.ellipsize = expanded
                ? Pango.EllipsizeMode.NONE
                : Pango.EllipsizeMode.END;
        }
    }

    /**
     * Bindet ScrollView und Anzeigen-Box per BindConstraint an die Spaltenbreite,
     * damit die Einträge die volle Spaltenbreite nutzen. St.BoxLayout füllt die
     * Querachse nicht von selbst (gemessen), deshalb explizit binden.
     */
    bindToColumnWidth() {
        const box = this._actor.get_parent();
        const scrollView = box?.get_parent();
        const column = scrollView?.get_parent();
        if (!box || !scrollView || !column)
            return;
        box.add_constraint(new Clutter.BindConstraint({
            source: column,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        scrollView.add_constraint(new Clutter.BindConstraint({
            source: column,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
    }

    /** Nach dem Laden der Termindetails die offene Zeile aktualisieren. */
    refreshExpanded() {
        if (!this._expandedEventId || !this._rows.has(this._expandedEventId))
            return;
        const {row, event} = this._rows.get(this._expandedEventId);
        this._removeDetails(row);
        this._appendDetails(row, event);
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
        this._sources = [];
        this._eventDetails = new Map();
        this._detailClients = new Map();
        this._detailsLoading = false;
        this._detailsAt = 0;
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
        this._loadDetails(true);

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
            detailsFor: event => this._eventDetails.get(eventUidOf(event)) ?? null,
        });

        this._openStateId = this._dateMenu.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                return;
            this._lookaheadDays = 0; // wieder vom eingestellten Fenster ausgehen
            this._queueRebuild(150);
            this._loadDetails();
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
        // ScrollView + Anzeigen-Box an die Spaltenbreite binden (100 % füllen).
        this._section.bindToColumnWidth();
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
        this._sources = [];
        this._eventDetails?.clear();
        this._eventDetails = new Map();
        this._detailClients?.clear();
        this._detailClients = new Map();

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
                this._sources.push(source);
                this._calendarNames.set(source.get_uid(), source.get_display_name());
            }
        } catch (e) {
            logError(e, '[productive-calendar] Kalendernamen nicht lesbar');
        }

        const names = [...this._calendarNames.values()].join(', ');
        this._debug('calendars', names, `Kalender: ${names}`);
    }

    // ---- Daten: Ort, Beschreibung, Teilnehmer über ECal --------------------

    _ecalQuery(begin, end) {
        const fmt = date => GLib.DateTime.new_from_unix_local(date.getTime() / 1000)
            .format('%Y%m%dT%H%M%S');
        let timezone = 'UTC';
        try {
            timezone = GLib.TimeZone.new_local().get_identifier();
        } catch {
            // UTC bleibt
        }
        return `occur-in-time-range? (make-time "${fmt(begin)}") ` +
            `(make-time "${fmt(end)}") "${timezone}"`;
    }

    _loadDetails(force = false) {
        if (this._detailsLoading || this._sources.length === 0)
            return;
        if (!force && this._detailsAt &&
            GLib.get_monotonic_time() - this._detailsAt < DETAILS_RELOAD_US)
            return;

        this._detailsLoading = true;
        this._detailsAt = GLib.get_monotonic_time();

        const [begin, end] = this._range(this._days());
        const query = this._ecalQuery(begin, end);
        let pending = 0;

        const finish = () => {
            if (--pending > 0)
                return;
            this._detailsLoading = false;
            this._debug('details', `${this._eventDetails.size}`,
                `Termindetails: ${this._eventDetails.size} bekannt`);
            this._section?.refreshExpanded();
        };

        const collect = client => {
            client.get_object_list_as_comps(query, null, (self, result) => {
                try {
                    const [ok, comps] = self.get_object_list_as_comps_finish(result);
                    for (const comp of ok ? (comps ?? []) : []) {
                        const uid = comp.get_uid();
                        if (!uid)
                            continue;

                        const details = {location: null, description: null, attendees: []};

                        try {
                            details.location = comp.get_location() || null;
                        } catch (e) {
                            // ohne Ort
                        }

                        try {
                            for (const text of comp.get_descriptions() ?? []) {
                                const value = textValue(text);
                                if (value) {
                                    details.description = value;
                                    break;
                                }
                            }
                        } catch (e) {
                            // ohne Beschreibung
                        }

                        try {
                            for (const attendee of comp.get_attendees() ?? []) {
                                const name = attendee.get_cn() || attendee.get_value();
                                if (name && name.trim())
                                    details.attendees.push(name.trim());
                            }
                        } catch (e) {
                            // ohne Teilnehmer
                        }

                        this._eventDetails.set(uid, details);
                    }
                } catch (e) {
                    logError(e, '[productive-calendar] Termindetails nicht lesbar');
                }
                finish();
            });
        };

        for (const source of this._sources) {
            const uid = source.get_uid();
            const cached = this._detailClients.get(uid);
            if (cached === 'failed')
                continue;

            pending++;
            if (cached) {
                collect(cached);
                continue;
            }

            try {
                ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 0, null,
                    (self, result) => {
                        let client = null;
                        try {
                            client = ECal.Client.connect_finish(result);
                        } catch (e) {
                            logError(e, `[productive-calendar] ECal-Verbindung fehlgeschlagen: ` +
                                `${source.get_display_name()}`);
                        }
                        if (client) {
                            this._detailClients.set(uid, client);
                            collect(client);
                        } else {
                            this._detailClients.set(uid, 'failed');
                            finish();
                        }
                    });
            } catch (e) {
                pending--;
                logError(e, '[productive-calendar] ECal-Verbindung nicht gestartet');
            }
        }

        if (pending === 0)
            this._detailsLoading = false;
    }

    // ---- Einstellungen ----------------------------------------------------

    _onSettingsChanged() {
        this._lookaheadDays = 0;
        // Nach einer Einstellungsänderung soll der nächste Zustand wieder
        // protokolliert werden, auch wenn er schon einmal dastand.
        this._logged.clear();
        this._applySettings();
        this._requestRange();
        this._loadDetails(true);
        this._queueRebuild(0);
    }

    _applySettings() {
        if (this._dateMenu?._calendar)
            this._dateMenu._calendar.visible = !this._settings.get_boolean('hide-calendar-grid');
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
