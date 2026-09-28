import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CalendarPreviewPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Appointments'),
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(page);

        // ---- Kalender ----------------------------------------------------

        const calendarGroup = new Adw.PreferencesGroup({
            title: _('Calendar'),
            description: _('The month calendar in the date menu'),
        });
        page.add(calendarGroup);

        const gridRow = new Adw.SwitchRow({
            title: _('Hide month grid'),
            subtitle: _('The month calendar takes up space. The header and the appointment list remain.'),
        });
        settings.bind('hide-calendar-grid', gridRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        calendarGroup.add(gridRow);

        // ---- Terminliste -------------------------------------------------

        const listGroup = new Adw.PreferencesGroup({
            title: _('Appointments'),
            description: _('What is shown instead of the day list'),
        });
        page.add(listGroup);

        const countRow = new Adw.SpinRow({
            title: _('Number of appointments'),
            subtitle: _('How many of the next appointments are shown'),
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
            title: _('Show all-day appointments'),
            subtitle: _('Birthdays, holidays and other all-day entries'),
        });
        settings.bind('show-all-day', allDayRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        listGroup.add(allDayRow);

        const pastRow = new Adw.SwitchRow({
            title: _('Show past and running appointments'),
            subtitle: _('The last two finished and the current one, at 50% opacity'),
        });
        settings.bind('show-past', pastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        listGroup.add(pastRow);

        const windowRow = new Adw.SpinRow({
            title: _('Preview period'),
            subtitle: _('Days into the future — automatically widened when needed'),
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

        const behaviourGroup = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behaviourGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('Log to journal'),
            subtitle: _('For debugging: which appointments were shown'),
        });
        settings.bind('debug-logging', debugRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(debugRow);
    }
}
