import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ProductiveCalendarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Productive Calendar'),
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(page);

        const listGroup = new Adw.PreferencesGroup({
            title: _('List'),
            description: _('What the appointment list in the date menu shows.'),
        });
        page.add(listGroup);

        const countRow = new Adw.SpinRow({
            title: _('Number of appointments'),
            subtitle: _('How many upcoming appointments to show'),
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
            title: _('Include all-day entries'),
            subtitle: _('Birthdays, holidays and other all-day entries'),
            active: settings.get_boolean('show-all-day'),
        });
        allDayRow.connect('notify::active', () =>
            settings.set_boolean('show-all-day', allDayRow.get_active()));
        settings.connect('changed::show-all-day', () =>
            allDayRow.set_active(settings.get_boolean('show-all-day')));
        listGroup.add(allDayRow);

        const windowRow = new Adw.SpinRow({
            title: _('Lookahead window'),
            subtitle: _('Days to look ahead — widened automatically when needed'),
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

        const behaviourGroup = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviourGroup);

        const clickRow = new Adw.SwitchRow({
            title: _('Open GNOME Calendar on click'),
            active: settings.get_boolean('open-calendar-on-click'),
        });
        clickRow.connect('notify::active', () =>
            settings.set_boolean('open-calendar-on-click', clickRow.get_active()));
        settings.connect('changed::open-calendar-on-click', () =>
            clickRow.set_active(settings.get_boolean('open-calendar-on-click')));
        behaviourGroup.add(clickRow);

        const gridRow = new Adw.SwitchRow({
            title: _('Hide the month grid'),
            subtitle: _('Leaves the header and the appointment list'),
            active: settings.get_boolean('hide-calendar-grid'),
        });
        gridRow.connect('notify::active', () =>
            settings.set_boolean('hide-calendar-grid', gridRow.get_active()));
        settings.connect('changed::hide-calendar-grid', () =>
            gridRow.set_active(settings.get_boolean('hide-calendar-grid')));
        behaviourGroup.add(gridRow);

        const debugRow = new Adw.SwitchRow({
            title: _('Log to the journal'),
            subtitle: _('For troubleshooting: which appointments were rendered'),
            active: settings.get_boolean('debug-logging'),
        });
        debugRow.connect('notify::active', () =>
            settings.set_boolean('debug-logging', debugRow.get_active()));
        settings.connect('changed::debug-logging', () =>
            debugRow.set_active(settings.get_boolean('debug-logging')));
        behaviourGroup.add(debugRow);
    }
}
