/* TouchpadIndicator - Touchpad management GNOME Shell Extension.
 * Orignal work Copyright (C) 2011-2013 Armin Köhler <orangeshirt at web.de>
 * Modifcations Copyright (C) 2019 Ashesh Singh <user501254 at gmail.com>
 *
 * This file is part of TouchpadIndicator, a fork of Armin Köhler's
 * 'gnome-shell-extension-touchpad-indicator' project which is licensed GPLv2.
 * Orignal source code is available at https://git.io/fjVec.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program; if not, write to:
 * The Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor
 * Boston, MA 02110-1301, USA.
 */


const { Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Mainloop = imports.mainloop;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;
const XInput = Me.imports.xinput;

//schema
const SCHEMA_EXTENSION = 'org.gnome.shell.extensions.touchpad-indicator';
const SCHEMA_TOUCHPAD = 'org.gnome.desktop.peripherals.touchpad';

//keys
const KEY_SEND_EVENTS = 'send-events';
const KEY_SWCH_METHOD = 'switchmethod';
const KEY_ALWAYS_SHOW = 'show-panelicon';
const KEY_NOTIFS_SHOW = 'show-notifications';
const KEY_TPD_ENABLED = 'touchpad-enabled';

//icons
const ICON_ENABLED = 'input-touchpad-symbolic';

let logging = Lib.logger;

var TouchpadIndicator = GObject.registerClass(
class TouchpadIndicatorButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Touchpad Indicator');
        this.hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box'
        });
        this.icon = new St.Icon({
            icon_name: ICON_ENABLED,
            style_class: 'system-status-icon'
        });
        this.hbox.add_child(this.icon);
        this.hbox.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));
        this.add_child(this.hbox);

        this.xinputIsUsable = Lib.executeCmdSync('xinput --list');

        if (this.xinputIsUsable[0] !== true) {
            logging('TouchpadIndicator._init(): Can`t find Xinput');
            this._extSettings.set_boolean('autoswitch-trackpoint', false);
        } else {
            logging('TouchpadIndicator._init(): Xinput is installed');
        }

        this.touchpadXinput = new XInput.XInput(Lib.ALL_TYPES['touchpad']);

        this._extSettings = ExtensionUtils.getSettings(SCHEMA_EXTENSION);
        this._tpdSettings = new Gio.Settings({ schema_id: SCHEMA_TOUCHPAD });

        // Purely for logging and debugging
        this._extSettings.connect(
            `changed::${KEY_TPD_ENABLED}`,
            this._logEKeyChange.bind(this));
        this._tpdSettings.connect(
            `changed::${KEY_SEND_EVENTS}`,
            this._logSKeyChange.bind(this));

        this._switchMethod = this._extSettings.get_enum(KEY_SWCH_METHOD);
        this._switchMethodChanged = false;

        if (this._switchMethod !== Lib.METHOD.XINPUT) {
            this.touchpadXinput._enableAllDevices();
        }

        if (this._switchMethod !== Lib.METHOD.GCONF) {
            if (this._tpdSettings.get_string(KEY_SEND_EVENTS) !== 'enabled' &&
                this._extSettings.get_boolean(KEY_TPD_ENABLED) === true)
                this._tpdSettings.set_string(KEY_SEND_EVENTS, 'enabled');
        }

        // Touchpad related change signals
        this._keyAlwaysShowSignal = this._extSettings.connect(
            `changed::${KEY_ALWAYS_SHOW}`,
            this._queueSyncMenuVisibility.bind(this));
        this._tpdSendEventsSignal = this._tpdSettings.connect(
            `changed::${KEY_SEND_EVENTS}`,
            this._queueSyncPointingDevice.bind(this));

        // Switch Method change signal
        this._keySwitchMthdSignal = this._extSettings.connect(
            `changed::${KEY_SWCH_METHOD}`,
            this._syncSwitchMethod.bind(this));

        // Emulate that a mouse is currently plugged in
        this._onMouseDevicePlugged(2);

        this._queueSyncPointingDevice(KEY_TPD_ENABLED);
        this._updateIcon();

        // To store all change signals on *-enabled extension keys
        this._enabledSignals = [];

        let touchpad = this._buildItem('Touchpad', KEY_TPD_ENABLED);
        this.menu.addMenuItem(touchpad);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addSettingsAction('Mouse & Touchpad Preferences',
            'gnome-mouse-panel.desktop');
        this.menu.addAction('Indicator Preferences', () => {
            Lib.executeCmdAsync(`gnome-shell-extension-prefs ${Me.uuid}`);
        });

        this.actor.show();

        this._watchDevInput = Lib.watchDevInput();
        this._watchDevInputSignal = this._watchDevInput.connect('changed',
            this._onDevicePlugged.bind(this));

        this._addKeybinding();
    }

    _logSKeyChange() {
        logging('_logSKeyChange: System Key Changed');
    }

    _logEKeyChange() {
        logging('_logEKeyChange: Extension Key Changed');
    }

    _buildItemExtended(string, initialValue, writable, onSet) {
        let widget = new PopupMenu.PopupSwitchMenuItem(string,
            initialValue);
        if (!writable)
            widget.actor.reactive = false;
        else
            widget.connect('toggled', item => {
                onSet(item.state);
            });
            // TODO: Warn/Confirm if user is disabling the last pointing device.
        return widget;
    }

    _buildItem(string, key) {
        let signal = this._extSettings.connect(`changed::${key}`, () => {
            widget.setToggleState(this._extSettings.get_boolean(key));
            this._queueSyncPointingDevice(key);
            this._queueSyncMenuVisibility();
            this._makeNotification();
            this._updateIcon();
        });

        this._enabledSignals.push(signal);

        let widget = this._buildItemExtended(string,
            this._extSettings.get_boolean(key),
            this._extSettings.is_writable(key),
            (enabled) => {
                if (this._extSettings.get_boolean(key) !== enabled) {
                    logging(`_buildItem - ${string} switch set to ${enabled}.`);
                    this._extSettings.set_boolean(key, enabled);
                }
            });
        return widget;
    }

    _queueSyncMenuVisibility() {
        if (this._syncMenuVisibilityIdle)
            return;

        this._syncMenuVisibilityIdle = Mainloop.idle_add(
            this._syncMenuVisibility.bind(this));
        GLib.Source.set_name_by_id(this._syncMenuVisibilityIdle,
            '[gnome-shell] this._syncMenuVisibility');
    }

    _syncMenuVisibility() {
        this._syncMenuVisibilityIdle = 0;

        let alwaysShow = this._extSettings.get_boolean(KEY_ALWAYS_SHOW);
        let items = this.menu._getMenuItems();

        this.actor.visible = alwaysShow || items.some(f => !!f.state);

        return GLib.SOURCE_REMOVE;
    }

    _notify(iconName, title, text) {
        if (this._notification)
            this._notification.destroy();

        this._ensureSource();

        let gicon = new Gio.ThemedIcon({ name: iconName });
        this._notification = new MessageTray.Notification(this._source, title,
            text, { gicon: gicon });
        this._notification.setUrgency(MessageTray.Urgency.LOW);
        this._notification.setTransient(true);
        this._notification.connect('destroy', () => {
            this._notification = null;
        });
        this._source.notify(this._notification);
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source('Touchpad Indicator',
                'touchpad-indicator');

            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
    }

    _syncSwitchMethod() {
        logging('_switchMethodChanged');

        let oldSwitchMethod = this._switchMethod;

        this._switchMethod = this._extSettings.get_enum(KEY_SWCH_METHOD);
        this._switchMethodChanged = true;
        logging(`_switchMethodChanged: ${this._switchMethodChanged}`);
        logging(`_switchMethodChanged: ${oldSwitchMethod}, ${this._switchMethod}`);

        if (this._switchMethod !== Lib.METHOD.XINPUT) {
            this.touchpadXinput._enableAllDevices();
        }

        this._queueSyncPointingDevice(KEY_TPD_ENABLED);
    }

    _checkGconfSync(valTpdEnabled, valSendEvents) {
        logging(`_checkGconfSync: ${valTpdEnabled}, ${valSendEvents}`);

        let bothEnabled = ((valTpdEnabled === true) &&
            (valSendEvents === 'enabled'));
        let bothDisabled = ((valTpdEnabled === false) &&
            (valSendEvents === 'disabled'));

        return (bothEnabled || bothDisabled);
    }

    _queueSyncPointingDevice(key) {
        logging('_queueSyncPointingDevice');

        // TODO: Check further for recursion, reduce complexity
        let valSendEvents = this._tpdSettings.get_string(KEY_SEND_EVENTS);
        let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);

        let isGconfInSync = this._checkGconfSync(valTpdEnabled, valSendEvents);

        // NOTE: When switch method is other than gconf (ie. xinput, synclient)
        //       let system's touchpad settings (`send-events` key) work on top
        //       of the switch method's touchpad enabling/disabling mechanism.
        if (isGconfInSync && (this._switchMethodChanged === false)) {
            logging('_queueSyncPointingDevice - Already in sync, return.');
            return;
        }

        switch (key) {
        // Touchpad enabled/disabled through SCHEMA_EXTENSION 'touchpad-enabled'
        case KEY_TPD_ENABLED:
            logging('_queueSyncPointingDevice: KEY_TPD_ENABLED');
            this._syncTouchpad(valTpdEnabled, valSendEvents, isGconfInSync);
            break;
        // Touchpad enabled/disabled through SCHEMA_TOUCHPAD 'send-events'
        default:
            logging('_queueSyncPointingDevice: default');
            this._onsetSendEvents(valTpdEnabled, valSendEvents);
        }

        if (this._switchMethodChanged === true) {
            this._switchMethodChanged = false;
        }
    }

    _syncTouchpad(valTpdEnabled, valSendEvents, isGconfInSync) {
        logging('_syncTouchpad');

        // NOTE: When extension's `touchpad-enabled` key is changed, always
        //       sync this change on to the system's `send-events` key, then
        //       procceed to enable/disable touchpad through the current
        //       switch method (if need be).
        switch (this._switchMethod) {
        case Lib.METHOD.GCONF:
            logging('_syncTouchpad: Lib.METHOD.GCONF');
            this._onsetTouchpadEnable(valTpdEnabled, valSendEvents);
            break;
        case Lib.METHOD.XINPUT:
            logging('_syncTouchpad: Lib.METHOD.XINPUT');
            if (isGconfInSync === false) {
                this._onsetTouchpadEnable(valTpdEnabled, valSendEvents);
            }
            this.touchpadXinput._switchAllDevices(valTpdEnabled);
            if ((valTpdEnabled === false) && !this.touchpadXinput.isPresent) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
            }
            break;
        }
    }

    _onsetSendEvents(valTpdEnabled, valSendEvents) {
        logging('_onsetSendEvents');

        // `send-events` is OFF / not ON; `touchpad-enabled` is ON
        //  set `touchpad-enabled` to OFF
        if ((valSendEvents !== 'enabled') && (valTpdEnabled !== false)) {
            logging('_onsetSendEvents: false');
            this._extSettings.set_boolean(KEY_TPD_ENABLED, false);
            return;
        }

        // `send-events` is ON; `touchpad-enabled` is OFF
        //  set `touchpad-enabled` to ON
        if ((valSendEvents === 'enabled') && (valTpdEnabled === false)) {
            logging('_onsetSendEvents: true');
            // Reset if touchpad was externally enabled through gsettings
            // and extension switch method is other than gconf.
            if (this._switchMethod !== Lib.METHOD.GCONF) {
                this.touchpadXinput._enableAllDevices();
            }
            this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
        }
    }

    _onsetTouchpadEnable(valTpdEnabled, valSendEvents) {
        logging('_onsetTouchpadEnable');

        // `touchpad-enabled` is ON; `send-events` is OFF / not ON;
        //  set `send-events` to ON
        if ((valTpdEnabled === true) && (valSendEvents !== 'enabled')) {
            logging('_onsetTouchpadEnable: enabled');
            this._tpdSettings.set_string(KEY_SEND_EVENTS, 'enabled');
            return;
        }

        // `touchpad-enabled` is OFF; `send-events` is ON / not OFF;
        //  set `send-events` to OFF
        if ((valTpdEnabled === false) && (valSendEvents !== 'disabled')) {
            logging('_onsetTouchpadEnable: disabled');
            this._tpdSettings.set_string(KEY_SEND_EVENTS, 'disabled');
        }
    }

    _makeNotification() {
        if (this._extSettings.get_boolean(KEY_NOTIFS_SHOW)) {
            let valSendEvents = this._tpdSettings.get_string(KEY_SEND_EVENTS);
            let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);

            if (valSendEvents === 'enabled' && valTpdEnabled) {
                this._notify('dialog-information',
                    `Touchpad Indicator ${Me.uuid}`,
                    'Touchpad Enabled');
            } else {
                this._notify('dialog-information',
                    `Touchpad Indicator ${Me.uuid}`,
                    'Touchpad Disabled');
            }
        }
    }

    _toggleTouchpadEnable() {
        this._extSettings.set_boolean(
            KEY_TPD_ENABLED,
            !this._extSettings.get_boolean(KEY_TPD_ENABLED));
    }

    _addKeybinding() {
        Main.wm.addKeybinding('toggle-touchpad', this._extSettings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this._toggleTouchpadEnable.bind(this));
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding('toggle-touchpad');
    }

    _updateIcon() {
        let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);
        this.icon.icon_name = valTpdEnabled ?
            ICON_ENABLED : 'touchpad-disabled-symbolic';
    }

    _onDevicePlugged(filemonitor, file, otherFile, eventType) {
        logging(`_onDevicePlugged: ${file.get_path()} ${eventType}`);

        if (file.get_path().indexOf('mouse') !== -1) {
            if ((eventType > 1) && (eventType < 4)) {
                this._onMouseDevicePlugged(eventType);
            }
        }
    }

    _onMouseDevicePlugged(eventType) {
        logging('_onMouseDevicePlugged');

        // TODO: Check auto switch behaviour on resume from sleep, restart.
        if (this._extSettings.get_boolean('autoswitch-touchpad')) {
            let pointingDevices = Lib.listPointingDevices()[1];
            let mouseDevices = pointingDevices.filter(p => p.type === 'mouse');
            let mouseCount = mouseDevices.length;

            logging(`_onMouseDevicePlugged - mouseCount is ${mouseCount}`);

            // no mouse device(s) is/are plugged in
            if (eventType === 2 && mouseCount === 0 &&
                !this._extSettings.get_boolean(KEY_TPD_ENABLED)) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
                return;
            }
            // mouse device(s) is/are plugged in
            if (eventType === 3 && mouseCount !== 0 &&
                this._extSettings.get_boolean(KEY_TPD_ENABLED)) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, false);
            }
            // TODO: Watch autoswitch-* key cahnges.
            //       Consider autoswitch-* key was set to 'false' while touchpad
            //       is disabled and then user unplugs the mouse.
        }
    }

    _disconnectSignals() {
        this._watchDevInput.disconnect(this._watchDevInputSignal);
        this._watchDevInput.cancel();
        for (let i = 0; i < this._enabledSignals.length; i++) {
            this._extSettings.disconnect(this._enabledSignals[i]);
        }
        this._extSettings.disconnect(this._keySwitchMthdSignal);
        this._extSettings.disconnect(this._keyAlwaysShowSignal);
        this._tpdSettings.disconnect(this._tpdSendEventsSignal);
    }

    // Make sure to enable related config when extension is disabled
    _resetConfig() {
        logging('_resetPointingDevices');
        this.touchpadXinput._enableAllDevices();
        // TODO: Set `send-events` to 'enabled' if its not?
    }
});

// eslint-disable-next-line no-unused-vars
function init() {
}

let _indicator;

// eslint-disable-next-line no-unused-vars
function enable() {
    _indicator = new TouchpadIndicator;
    Main.panel.addToStatusArea('touchpad-indicator', _indicator);
}

// eslint-disable-next-line no-unused-vars
function disable() {
    _indicator._disconnectSignals();
    _indicator._removeKeybinding();
    _indicator._resetConfig();
    _indicator.destroy();
}
