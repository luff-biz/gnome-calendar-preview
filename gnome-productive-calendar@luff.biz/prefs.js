import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ProductiveCalendarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Terminliste'),
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(page);

        // ---- Kalender ----------------------------------------------------

        const calendarGroup = new Adw.PreferencesGroup({
            title: _('Kalender'),
            description: _('Der Monatskalender im Datumsmenü'),
        });
        page.add(calendarGroup);

        const gridRow = new Adw.SwitchRow({
            title: _('Monatsgitter ausblenden'),
            subtitle: _('Der Monatskalender nimmt Platz weg. Es bleiben die Kopfzeile und die Terminliste.'),
        });
        settings.bind('hide-calendar-grid', gridRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        calendarGroup.add(gridRow);

        // ---- Terminliste -------------------------------------------------

        const listGroup = new Adw.PreferencesGroup({
            title: _('Terminliste'),
            description: _('Was anstelle der Tagesliste angezeigt wird'),
        });
        page.add(listGroup);

        const countRow = new Adw.SpinRow({
            title: _('Anzahl der Termine'),
            subtitle: _('Wie viele der nächsten Termine angezeigt werden'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20, step_increment: 1, page_increment: 5,
                value: settings.get_int('event-count'),
            }),
        });
        countRow.connect('notify::value', () =>
            settings.set_int('event-count', countRow.get_value()));
        settings.connect('changed::event-count', () =>
            countRow.set_value(settings.get_int('event-count')));
        listGroup.add(countRow);

        const allDayRow = new Adw.SwitchRow({
            title: _('Ganztägige Termine anzeigen'),
            subtitle: _('Geburtstage, Ferien und andere ganztägige Einträge'),
        });
        settings.bind('show-all-day', allDayRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        listGroup.add(allDayRow);

        const pastRow = new Adw.SwitchRow({
            title: _('Vergangene und laufende Termine anzeigen'),
            subtitle: _('Die letzten zwei beendeten und der laufende, bei 50 % Deckkraft'),
        });
        settings.bind('show-past', pastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        listGroup.add(pastRow);

        const windowRow = new Adw.SpinRow({
            title: _('Vorschau-Zeitraum'),
            subtitle: _('Tage in die Zukunft — wird bei Bedarf automatisch vergrößert'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 730, step_increment: 10, page_increment: 60,
                value: settings.get_int('lookahead-days'),
            }),
        });
        windowRow.connect('notify::value', () =>
            settings.set_int('lookahead-days', windowRow.get_value()));
        settings.connect('changed::lookahead-days', () =>
            windowRow.set_value(settings.get_int('lookahead-days')));
        listGroup.add(windowRow);

        // ---- Verhalten ---------------------------------------------------

        const behaviourGroup = new Adw.PreferencesGroup({title: _('Verhalten')});
        page.add(behaviourGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('Ins Journal protokollieren'),
            subtitle: _('Zur Fehlersuche: welche Termine angezeigt wurden'),
        });
        settings.bind('debug-logging', debugRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(debugRow);
    }
}
