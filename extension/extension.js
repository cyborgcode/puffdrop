// Omdrop's panel: a top-bar icon and its menu. A GNOME Shell port of
// Omdrop's Omarchy panel (Panel.qml). It owns no settings: `omdrop` is the
// single source of truth, asked for `status --json` while the menu is open and
// every ten seconds otherwise, so the icon stays right when a window expires
// or something else turns receiving off.
//
// The three answers that matter are kept apart:
//   receiving + visible      someone's share sheet can show us
//   receiving + not visible  the receiver is up but nothing is advertising
//   visible == null          the radio half is absent; we cannot tell, and
//                            must not draw that as either answer

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Cli, findCli} from './cli.js';
import {Radar} from './radar.js';

// Discrete stops rather than a free scale: the useful values are few, and the
// two ends are modes, not durations.
const WINDOW_STOPS = [
    {arg: 'once', label: 'One file, then off'},
    {arg: '1m', label: '1 minute'},
    {arg: '5m', label: '5 minutes'},
    {arg: '10m', label: '10 minutes'},
    {arg: '15m', label: '15 minutes'},
    {arg: '30m', label: '30 minutes'},
    {arg: '60m', label: '1 hour'},
    {arg: 'forever', label: 'Until I turn it off'},
];
const DEFAULT_STOP = 3;

// The receiver comes up at once and the radio takes about ten seconds after
// it, so a stretch of "on but unseen" is normal for this long, in seconds.
const SETTLE_SECONDS = 200;

const DBUS_PATH = '/io/github/cyborgcode/Omdrop';
const DBUS_IFACE = `<node>
  <interface name="io.github.cyborgcode.Omdrop">
    <method name="CopyText"><arg type="s" direction="in" name="text"/></method>
    <method name="CopyFile">
      <arg type="s" direction="in" name="path"/>
      <arg type="s" direction="in" name="mimeType"/>
    </method>
  </interface>
</node>`;
const CLIPBOARD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const CLIPBOARD_MAX_BYTES = 32 * 1024 * 1024;

// A duration as `omdrop window` saves it, to the nearest stop.
function stopForWindow(window) {
    if (window === 'once')
        return 0;
    if (window === 'forever')
        return WINDOW_STOPS.length - 1;
    const m = /^(\d+)(s|sec|m|min|h|hour|d|day)?$/.exec(window ?? '');
    if (!m)
        return DEFAULT_STOP;
    const unit = {s: 1 / 60, sec: 1 / 60, m: 1, min: 1, h: 60, hour: 60, d: 1440, day: 1440}[m[2] ?? 'm'];
    const minutes = Number(m[1]) * unit;
    let best = DEFAULT_STOP, bestDistance = Infinity;
    for (let i = 1; i < WINDOW_STOPS.length - 1; i++) {
        const d = Math.abs(parseInt(WINDOW_STOPS[i].arg) - minutes);
        if (d < bestDistance) {
            best = i;
            bestDistance = d;
        }
    }
    return best;
}

// Secondary text is dimmed by opacity rather than a fixed grey, so it keeps
// its relation to the theme's own text colour in light and dark styles.
const DIM = 166;

function wrappingLabel(styleClass) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function header(text) {
    const label = new St.Label({text, style_class: 'omdrop-header', y_align: Clutter.ActorAlign.CENTER, opacity: DIM});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// A menu row that acts when chosen and leaves the menu open, the way the
// panel's rows did: closing on every press would hide what the press did.
const ActionItem = GObject.registerClass(
class OmdropActionItem extends PopupMenu.PopupBaseMenuItem {
    _init(onActivate, params = {}) {
        super._init(params);
        this._onActivate = onActivate;
    }

    activate(_event) {
        this._onActivate();
    }
});

// A row that only holds things: not a target of its own. Reactive, so the
// theme does not draw it insensitive (greyed), but never activated, focused
// or highlighted itself; what it holds still takes clicks and focus.
function holder(styleClass = '') {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: true, activate: false, hover: false, can_focus: false,
        style_class: `omdrop-holder ${styleClass}`,
    });
    // No hover highlight either: it is not a target.
    item.track_hover = false;
    return item;
}

const Indicator = GObject.registerClass(
class OmdropIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Omdrop');
        this._extension = extension;
        this._cli = new Cli(findCli(extension.path));
        this._gicon = Gio.icon_new_for_string(`${extension.path}/icons/omdrop-symbolic.svg`);
        this._giconCrossed = Gio.icon_new_for_string(`${extension.path}/icons/omdrop-crossed-symbolic.svg`);
        this._soundDir = GLib.build_filenamev([GLib.path_get_dirname(GLib.path_get_dirname(this._cli.path)), 'share', 'sounds']);

        this._panelIcon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon omdrop-panel-icon'});
        this._panelIcon.set_pivot_point(0.5, 0.5);
        this.add_child(this._panelIcon);

        this._state = {
            installed: false, receiving: false, visibility: -1, remaining: -1,
            deviceName: '', downloadDir: '', blockedReason: '', audience: 'everyone', senders: 0,
            lastError: '', busy: false, turningOn: false, busyElapsed: 0, settleElapsed: 0,
            windowIndex: DEFAULT_STOP, windowMode: '', windowSeeded: false, windowPicking: false,
            pendingName: '', sentName: '', pickingDir: false,
            radarOpen: false, soundOn: true, peers: [], namesResolved: false,
            sendersOpen: false, senderList: [], senderError: '',
            sendingTo: '', sendingName: '', sendStatus: '', sendChosen: false,
            sendFailed: false, sendDone: false, sendCancelled: false, sendingFile: '',
            doctorText: '', driverInstallable: false,
        };
        this._peerNames = new Map();     // mac -> name, everything learnt this session
        this._flashed = new Set();       // rows that have had their arrival flash
        this._rows = new Map();          // mac -> peer row
        this._dots = '.';
        this._radarDots = '.';
        this._timers = new Map();
        this._statusRunning = false;
        this._statusStale = false;
        this._busy = new Set();          // which one-at-a-time commands are running
        this._sendProc = null;
        this._namesProc = null;
        this._scanning = false;
        this._drifting = false;

        this.menu.actor.add_style_class_name('omdrop-menu');
        this._buildMenu();
        this.menu.connect('open-state-changed', (_m, open) => this._openChanged(open));
        this.menu.actor.connect('key-press-event', (_a, event) => this._onKey(event));
        this.connect('destroy', () => this._teardown());

        this._armResync();
        this._refreshStatus();
        this._render();
    }

    // ------------------------------------------------------------ derived

    get _usable() {
        return this._state.installed && this._state.visibility !== -1;
    }

    get _settling() {
        const s = this._state;
        return s.receiving && s.visibility !== 1 && s.settleElapsed < SETTLE_SECONDS;
    }

    get _windowArg() {
        return WINDOW_STOPS[this._state.windowIndex].arg;
    }

    get _countingDown() {
        const s = this._state;
        return s.receiving && s.remaining > 0 && !s.windowPicking;
    }

    get _sendRunning() {
        return this._sendProc !== null;
    }

    get _sendActive() {
        return this._sendRunning && this._state.sendChosen;
    }

    get _shownName() {
        return this._state.pendingName !== '' ? this._state.pendingName : this._state.deviceName;
    }

    // What the radio side says is wrong, in words rather than a token.
    get _reasonText() {
        const s = this._state;
        switch (s.blockedReason) {
        case 'no_awdl0':
            return 'The AWDL interface is missing. The radio backend needs starting.';
        // Parked-with-a-template-loaded cannot be cleared from userspace; the
        // command's own message names the way out, shown verbatim instead.
        case 'parked':
        case 'ok':
        case 'expired':
        case 'stopped':
        case '':
            return '';
        default:
            return s.visibility === 1 ? '' : `The radio side reports: ${s.blockedReason}`;
        }
    }

    // The headline names the state of what the switch controls. The one
    // exception stays a headline: a window open while nothing can see us is a
    // fault, not a nuance.
    get _stateText() {
        const s = this._state;
        if (!this._usable)
            return 'Not available';
        if (s.busy)
            return `${s.turningOn ? 'Turning on' : 'Turning off'}${this._dots}`;
        if (this._settling)
            return `Waking the radio${this._dots}`;
        if (!s.receiving)
            return 'Omdrop off';
        if (s.visibility === 0)
            return 'Nobody can see you yet';
        return 'Omdrop on';
    }

    get _visibleText() {
        const s = this._state;
        const who = s.deviceName !== '' ? `"${s.deviceName}"` : 'this computer';
        if (s.audience === 'contacts') {
            if (s.senders === 0)
                return 'Your known-senders list is empty, so everyone is refused. Add people with the button on the right.';
            return `Only your ${s.senders} known sender${s.senders === 1 ? '' : 's'} should see ${who} in AirDrop, after 10 seconds.`;
        }
        return `Nearby Apple devices should see ${who} in AirDrop, after 10 seconds.`;
    }

    get _detailText() {
        const s = this._state;
        if (!s.installed)
            return `The omdrop command did not answer (${this._cli.path}). Run bin/omdrop setup in the Omdrop checkout.`;
        if (!this._usable)
            return s.doctorText !== '' ? s.doctorText : 'Needs the radio backend the Omdrop README describes.';
        if (this._settling)
            return 'The radio takes a few seconds to come up.';
        if (s.lastError !== '')
            return s.lastError;
        if (this._reasonText !== '')
            return this._reasonText;
        if (!s.receiving)
            return 'Nearby Apple devices cannot see this computer.';
        if (s.visibility === 0)
            return 'The receiver is up, but nothing is advertising on the radio.';
        return this._visibleText;
    }

    get _detailUrgent() {
        const s = this._state;
        return this._detailText === this._visibleText && s.audience === 'contacts' && s.senders === 0;
    }

    // While a timed window runs, the chosen duration is replaced by what is
    // left of it; while a hand is on the slider, the label comes back.
    get _windowValueText() {
        const s = this._state;
        if (!this._countingDown)
            return WINDOW_STOPS[s.windowIndex].label;
        const m = Math.floor(s.remaining / 60), sec = s.remaining % 60;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    get _countdownText() {
        const s = this._state;
        if (!s.busy || s.busyElapsed < 4)
            return '';
        const m = Math.floor(s.busyElapsed / 60), sec = s.busyElapsed % 60;
        return `${s.turningOn ? 'WAKING THE RADIO' : 'STOPPING'} · ${m}:${String(sec).padStart(2, '0')}`;
    }

    get _scanningNow() {
        const s = this._state;
        return s.radarOpen && this.menu.isOpen && s.receiving && s.visibility === 1;
    }

    get _radarStatus() {
        const s = this._state;
        if (!s.receiving)
            return 'Turning Omdrop on';
        if (!this._scanningNow)
            return 'Waiting for the radio';
        if (s.peers.length === 0)
            return 'Searching for peers';
        if (!s.namesResolved)
            return 'Resolving peer names';
        return '';
    }

    get _radarWorking() {
        return this._state.radarOpen && this._radarStatus !== '';
    }

    // The device a send is going to stays listed until that send is over,
    // even if a poll stops hearing it, and even if it never gave a name.
    get _namedPeers() {
        const s = this._state;
        const list = s.peers.filter(p => p.name !== '');
        if (s.sendingTo !== '' && !list.some(p => p.mac === s.sendingTo))
            list.push({mac: s.sendingTo, rssi: null, name: this._peerNames.get(s.sendingTo) || s.sendingName});
        return list;
    }

    // -------------------------------------------------------------- menu

    _buildMenu() {
        const menu = this.menu;

        // The switch, and the state it controls.
        this._hero = new ActionItem(() => this._toggle(), {style_class: 'omdrop-hero'});
        this._heroIcon = new St.Icon({gicon: this._gicon, style_class: 'omdrop-hero-icon'});
        this._heroIcon.set_pivot_point(0.5, 0.5);
        const heroLabels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._stateLabel = new St.Label({style_class: 'omdrop-state'});
        this._countdownLabel = new St.Label({style_class: 'omdrop-countdown', opacity: DIM});
        heroLabels.add_child(this._stateLabel);
        heroLabels.add_child(this._countdownLabel);
        this._switch = new PopupMenu.Switch(false);
        this._switch.y_align = Clutter.ActorAlign.CENTER;
        this._hero.add_child(this._heroIcon);
        this._hero.add_child(heroLabels);
        this._hero.add_child(this._switch);
        menu.addMenuItem(this._hero);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._detailItem = holder();
        this._detail = wrappingLabel('omdrop-detail');
        this._detailItem.add_child(this._detail);
        menu.addMenuItem(this._detailItem);

        // The one thing a first run can act on from here. It opens a terminal
        // rather than installing anything quietly: installing a radio backend
        // is the user's decision, taken at their own sudo prompt.
        this._installItem = holder();
        this._installButton = new St.Button({label: 'Install the radio backend', style_class: 'button omdrop-install', can_focus: true});
        this._installButton.connect('clicked', () => this._installDriver());
        this._installItem.add_child(this._installButton);
        menu.addMenuItem(this._installItem);

        this._usableItems = [];
        const usableSeparator = () => {
            const sep = new PopupMenu.PopupSeparatorMenuItem();
            this._usableItems.push(sep);
            menu.addMenuItem(sep);
        };

        // How long a press of the switch keeps us visible.
        usableSeparator();
        const windowHead = holder();
        windowHead.add_child(header('STAY VISIBLE FOR'));
        windowHead.add_child(new St.Widget({x_expand: true}));
        this._windowValue = new St.Label({style_class: 'omdrop-window-value', y_align: Clutter.ActorAlign.CENTER});
        windowHead.add_child(this._windowValue);
        menu.addMenuItem(windowHead);
        this._usableItems.push(windowHead);

        const windowRow = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'omdrop-slider-row'});
        this._slider = new Slider(this._state.windowIndex / (WINDOW_STOPS.length - 1));
        this._slider.x_expand = true;
        this._slider.accessible_name = 'Stay visible for';
        this._slider.connect('notify::value', () => this._sliderMoved());
        this._slider.connect('drag-begin', () => {
            this._sliderDragging = true;
            this._state.windowPicking = true;
            this._render();
        });
        this._slider.connect('drag-end', () => {
            this._sliderDragging = false;
            this._sliderReleased();
        });
        windowRow.add_child(this._slider);
        windowRow.connect('key-press-event', (_a, event) => this._slider.emit('key-press-event', event));
        menu.addMenuItem(windowRow);
        this._usableItems.push(windowRow);

        // Who may send. Shown while off too, so the choice can be made before
        // a window opens. It is saved, and applies to every window.
        usableSeparator();
        const audienceRow = holder('omdrop-audience');
        this._tabEveryone = this._audienceTab('system-users-symbolic', 'EVERYONE', 'everyone');
        this._tabContacts = this._audienceTab('avatar-default-symbolic', 'CONTACTS ONLY', 'contacts');
        audienceRow.add_child(this._tabEveryone);
        audienceRow.add_child(this._tabContacts);
        audienceRow.add_child(new St.Widget({x_expand: true}));
        const sendersBox = new St.BoxLayout({style_class: 'omdrop-senders-button-box'});
        sendersBox.add_child(new St.Icon({icon_name: 'contact-new-symbolic', style_class: 'omdrop-small-icon'}));
        this._sendersCount = new St.Label({style_class: 'omdrop-senders-count', y_align: Clutter.ActorAlign.CENTER});
        sendersBox.add_child(this._sendersCount);
        this._sendersButton = new St.Button({
            child: sendersBox, style_class: 'omdrop-tab omdrop-senders-button', can_focus: true,
            accessible_name: 'Known senders, for Contacts Only',
        });
        this._sendersButton.connect('clicked', () => this._toggleSenders());
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            this._sendersButton.connect(signal, () => this._render());
        audienceRow.add_child(this._sendersButton);
        menu.addMenuItem(audienceRow);
        this._usableItems.push(audienceRow);

        // The known-senders list, opened from the button above.
        this._sendersSection = new PopupMenu.PopupMenuSection();
        this._senderRows = new PopupMenu.PopupMenuSection();
        this._sendersSection.addMenuItem(this._senderRows);
        const senderEntryItem = holder();
        this._senderEntry = new St.Entry({
            hint_text: 'Apple ID email or phone number', can_focus: true, x_expand: true,
            style_class: 'omdrop-entry',
        });
        this._senderEntry.clutter_text.connect('activate', () => this._addSender(this._senderEntry.get_text()));
        this._senderEntry.clutter_text.connect('text-changed', () => {
            if (this._state.senderError !== '') {
                this._state.senderError = '';
                this._render();
            }
        });
        senderEntryItem.add_child(this._senderEntry);
        this._sendersSection.addMenuItem(senderEntryItem);
        this._senderNoteItem = holder();
        this._senderNote = wrappingLabel('omdrop-caption');
        this._senderNoteItem.add_child(this._senderNote);
        this._sendersSection.addMenuItem(this._senderNoteItem);
        menu.addMenuItem(this._sendersSection);

        // Sending: a header that opens onto the radar, the devices that can be
        // sent to, and the radar itself.
        usableSeparator();
        this._peersHead = new ActionItem(() => this._openRadar(), {style_class: 'omdrop-peers-head'});
        this._peersHead.add_child(header('SEND TO PEERS'));
        this._peersHead.add_child(new St.Widget({x_expand: true}));
        this._peersCount = new St.Label({style_class: 'omdrop-caption', y_align: Clutter.ActorAlign.CENTER, opacity: DIM});
        this._peersHead.add_child(this._peersCount);
        this._chevron = new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'omdrop-small-icon'});
        this._chevron.set_pivot_point(0.5, 0.5);
        this._peersHead.add_child(this._chevron);
        menu.addMenuItem(this._peersHead);
        this._usableItems.push(this._peersHead);

        this._radarSection = new PopupMenu.PopupMenuSection();
        this._radarStatusItem = holder('omdrop-radar-status');
        const statusBox = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._radarStatusWords = new St.Label({opacity: DIM});
        // The words stay still and only the dots move: the dots sit in a label
        // of their own, wide enough for three of them.
        this._radarStatusDots = new St.Label({style_class: 'omdrop-dots', opacity: DIM});
        statusBox.add_child(this._radarStatusWords);
        statusBox.add_child(this._radarStatusDots);
        this._radarStatusItem.add_child(statusBox);
        this._radarSection.addMenuItem(this._radarStatusItem);
        this._peerRowsSection = new PopupMenu.PopupMenuSection();
        this._radarSection.addMenuItem(this._peerRowsSection);
        this._peerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._radarSection.addMenuItem(this._peerSeparator);
        const radarItem = holder('omdrop-radar-item');
        this._radar = new Radar(this._soundDir);
        this._radar.connect('peer-clicked', (_r, mac) => this._sendTo(mac));
        this._radar.connect('mute-toggled', () => this._toggleSound());
        radarItem.add_child(this._radar);
        this._radarSection.addMenuItem(radarItem);
        menu.addMenuItem(this._radarSection);

        usableSeparator();
        const nameHead = holder();
        nameHead.add_child(header('THEY SEE YOU AS'));
        menu.addMenuItem(nameHead);
        this._usableItems.push(nameHead);
        const nameItem = holder();
        this._nameEntry = new St.Entry({can_focus: true, x_expand: true, style_class: 'omdrop-entry'});
        // An edit is kept when the field loses focus, not only on Enter;
        // Escape abandons it.
        this._nameEntry.clutter_text.connect('activate', () => this._setDeviceName(this._nameEntry.get_text()));
        this._nameEntry.clutter_text.connect('key-focus-out', () => {
            if (this._abandonName)
                this._abandonName = false;
            else
                this._setDeviceName(this._nameEntry.get_text());
            this._nameEntry.set_text(this._shownName);
        });
        this._nameEntry.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._abandonName = true;
                this._nameEntry.set_text(this._shownName);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        nameItem.add_child(this._nameEntry);
        menu.addMenuItem(nameItem);
        this._usableItems.push(nameItem);

        const dirHead = holder();
        dirHead.add_child(header('SAVE FILES TO'));
        menu.addMenuItem(dirHead);
        this._usableItems.push(dirHead);
        // Chosen in the file chooser, not typed: the chooser can only answer
        // with a folder that exists.
        const dirItem = holder();
        const dirBox = new St.BoxLayout({x_expand: true});
        dirBox.add_child(new St.Icon({icon_name: 'folder-open-symbolic', style_class: 'omdrop-small-icon'}));
        this._dirLabel = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'omdrop-dir-label'});
        this._dirLabel.clutter_text.ellipsize = Pango.EllipsizeMode.START;
        dirBox.add_child(this._dirLabel);
        this._dirButton = new St.Button({
            child: dirBox, style_class: 'button omdrop-dir', x_expand: true, can_focus: true,
            accessible_name: 'Choose another folder',
        });
        this._dirButton.connect('clicked', () => this._pickDownloadDir());
        dirItem.add_child(this._dirButton);
        menu.addMenuItem(dirItem);
        this._usableItems.push(dirItem);
    }

    _audienceTab(icon, label, mode) {
        const box = new St.BoxLayout({style_class: 'omdrop-tab-box'});
        box.add_child(new St.Icon({icon_name: icon, style_class: 'omdrop-small-icon'}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({child: box, style_class: 'omdrop-tab', can_focus: true, accessible_name: label});
        button.connect('clicked', () => this._setAudience(mode));
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            button.connect(signal, () => this._render());
        return button;
    }

    // ------------------------------------------------------------ render

    _render() {
        const s = this._state;
        const usable = this._usable;
        const lit = s.busy || s.receiving;

        this._panelIcon.gicon = usable ? this._gicon : this._giconCrossed;
        this._panelIcon.opacity = lit ? 255 : 140;
        this._heroIcon.gicon = usable ? this._gicon : this._giconCrossed;
        this._heroIcon.opacity = lit ? 255 : 140;
        this._setDrifting(s.busy || this._settling);

        this._stateLabel.text = this._stateText;
        this._countdownLabel.text = this._countdownText;
        this._countdownLabel.visible = this._countdownLabel.text !== '';
        this._switch.visible = usable;
        this._switch.state = s.receiving;
        this._hero.reactive = usable;

        this._detail.text = this._detailText;
        this._detailItem.visible = this._detail.text !== '';
        this._setUrgent(this._detail, this._detailUrgent);
        this._installItem.visible = !usable && s.driverInstallable;

        for (const item of this._usableItems)
            item.visible = usable;

        this._windowValue.text = this._windowValueText;
        this._windowValue.remove_style_class_name('omdrop-urgent');
        this._windowValue.remove_style_class_name('omdrop-bold');
        if (this._countingDown) {
            this._windowValue.add_style_class_name('omdrop-bold');
            // The last minute is when you care whether to press again.
            if (s.remaining <= 60)
                this._windowValue.add_style_class_name('omdrop-urgent');
        }
        if (!s.windowPicking)
            this._setSlider(s.windowIndex);

        this._setSelected(this._tabEveryone, s.audience === 'everyone');
        this._setSelected(this._tabContacts, s.audience === 'contacts');
        this._setSelected(this._sendersButton, s.sendersOpen);
        this._sendersCount.text = s.senders > 0 ? String(s.senders) : '';
        this._sendersCount.visible = s.senders > 0;

        this._sendersSection.actor.visible = usable && s.sendersOpen;
        this._senderNote.text = s.senderError !== '' ? s.senderError
            : s.senderList.length === 0 ? 'In Contacts Only, only these people can send to you. Use the email or phone number of their Apple ID.' : '';
        this._setUrgent(this._senderNote, s.senderError !== '');
        this._senderNoteItem.visible = this._senderNote.text !== '';

        const named = this._namedPeers;
        this._peersCount.text = named.length > 0 ? `${named.length} device${named.length === 1 ? '' : 's'}` : '';
        this._peersCount.visible = !s.radarOpen && named.length > 0;
        this._chevron.rotation_angle_z = s.radarOpen ? 180 : 0;
        this._radarSection.actor.visible = usable && s.radarOpen;
        this._radarStatusItem.visible = this._radarWorking;
        this._radarStatusWords.text = this._radarStatus;
        this._radarStatusDots.text = this._radarDots;
        this._peerSeparator.visible = named.length > 0;
        this._radar.setMuted(!s.soundOn);
        this._syncPeerRows(named);

        if (!this._nameEntry.clutter_text.has_key_focus())
            this._nameEntry.set_text(this._shownName);
        this._dirLabel.text = s.pickingDir ? 'Choosing in Files…' : this._tildify(s.downloadDir);

        this._updateScanning();
        this._updateTimers();
    }

    // The chosen tab is lit; the others stay dim until hovered or focused.
    _setSelected(button, selected) {
        if (selected)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
        button.opacity = selected || button.hover || button.has_key_focus() ? 255 : DIM;
    }

    // A fault reads at full strength in red; otherwise the text is secondary.
    _setUrgent(label, urgent, calm = DIM) {
        if (urgent)
            label.add_style_class_name('omdrop-urgent');
        else
            label.remove_style_class_name('omdrop-urgent');
        label.opacity = urgent ? 255 : calm;
    }

    _setSlider(index) {
        const value = index / (WINDOW_STOPS.length - 1);
        if (Math.abs(this._slider.value - value) > 1e-6) {
            this._sliderSync = true;
            this._slider.value = value;
            this._sliderSync = false;
        }
    }

    _tildify(path) {
        const home = GLib.get_home_dir();
        return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
    }

    // It sways and sinks while the radio comes up, rather than spinning: the
    // wait is 15-60 s, and a spinner that long reads as a hang.
    _setDrifting(drifting) {
        if (this._drifting === drifting)
            return;
        this._drifting = drifting;
        for (const icon of [this._panelIcon, this._heroIcon]) {
            if (drifting)
                this._drift(icon, 0);
            else
                icon.ease({translation_y: 0, rotation_angle_z: 0, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_SINE});
        }
    }

    _drift(icon, step) {
        if (!this._drifting)
            return;
        const swings = [[1.6, 4], [-1.6, -4]];
        const [y, angle] = swings[step % 2];
        icon.ease({
            translation_y: y, rotation_angle_z: angle, duration: step === 0 ? 800 : 1600,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._drift(icon, step + 1),
        });
    }

    // ------------------------------------------------------------ timers

    _timer(name, ms, fn) {
        if (this._timers.has(name))
            return;
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    _stopTimer(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    _once(name, ms, fn) {
        this._stopTimer(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    // The resync notices a window that ended somewhere else: an expiry, or
    // someone running `omdrop off` in a terminal.
    _armResync() {
        this._stopTimer('resync');
        this._timer('resync', this.menu.isOpen ? 3000 : 10000, () => {
            if (!this._statusRunning)
                this._refreshStatus();
        });
    }

    _updateTimers() {
        const s = this._state;
        // The countdown ticks here: asking the command once a second would
        // spawn processes for a number we can count ourselves.
        const seconds = this._countingDown || s.busy || (s.receiving && s.visibility !== 1);
        if (seconds) {
            this._timer('second', 1000, () => this._tickSecond());
        } else {
            this._stopTimer('second');
            s.busyElapsed = 0;
            s.settleElapsed = 0;
        }
        if (s.busy || this._settling) {
            this._timer('dots', 450, () => {
                this._dots = this._dots.length >= 3 ? '.' : `${this._dots}.`;
                this._render();
            });
        } else {
            this._stopTimer('dots');
            this._dots = '.';
        }
        // Through ".", "..", "..." and then none, so the pause reads as a breath.
        if (this._radarWorking) {
            this._timer('radarDots', 450, () => {
                this._radarDots = this._radarDots === '...' ? '' : `${this._radarDots}.`;
                this._radarStatusDots.text = this._radarDots;
            });
        } else {
            this._stopTimer('radarDots');
            this._radarDots = '.';
        }
    }

    _tickSecond() {
        const s = this._state;
        if (s.busy)
            s.busyElapsed++;
        if (s.receiving && s.visibility !== 1)
            s.settleElapsed++;
        if (this._countingDown) {
            s.remaining--;
            // Zero is the moment the window ends: the timer unit is turning
            // receiving off right now, so stop showing it as running.
            if (s.remaining <= 0) {
                s.remaining = -1;
                s.receiving = false;
                s.visibility = 0;
                this._refreshStatus();
            }
        }
        this._render();
    }

    // ------------------------------------------------------------ status

    // A request that arrives while a poll is running is queued, not dropped:
    // the answer in flight predates the change, so it is discarded.
    async _refreshStatus() {
        if (this._statusRunning) {
            this._statusStale = true;
            return;
        }
        this._statusRunning = true;
        let result;
        do {
            this._statusStale = false;
            result = await this._cli.run(['status', '--json']);
        } while (this._statusStale && !this._destroyed);
        this._statusRunning = false;
        if (this._destroyed)
            return;
        if (!result.ok) {
            this._state.installed = false;
            this._render();
            return;
        }
        this._applyStatus(result.stdout);
    }

    _applyStatus(text) {
        const s = this._state;
        let j;
        try {
            j = JSON.parse(text);
        } catch {
            s.installed = false;
            this._render();
            return;
        }
        s.installed = true;
        s.receiving = Boolean(j.receiving);
        s.visibility = j.visible === null || j.visible === undefined ? -1 : j.visible ? 1 : 0;
        s.remaining = j.remaining === null || j.remaining === undefined ? -1 : j.remaining;
        s.deviceName = j.name || '';
        s.downloadDir = j.dir || '';
        s.blockedReason = j.reason || '';
        if (!s.windowSeeded && !s.windowPicking) {
            s.windowIndex = stopForWindow(j.window);
            s.windowSeeded = true;
        }
        this._syncWindowToRunning(j.mode || 'off');
        if (!this._busy.has('sound'))
            s.soundOn = j.sound !== false;
        if (!this._busy.has('audience'))
            s.audience = j.visibility === 'contacts' ? 'contacts' : 'everyone';
        s.senders = j.senders || 0;
        // Asked once per transition into unusable, not on every poll.
        if (!this._usable && s.doctorText === '' && !this._busy.has('doctor'))
            this._askDoctor();
        if (this._usable) {
            s.doctorText = '';
            s.driverInstallable = false;
        }
        this._render();
    }

    // The slider is a control and a report: while a window runs it shows the
    // window that is running. Only on a change of mode, so a running window
    // never fights a hand on the slider.
    _syncWindowToRunning(mode) {
        const s = this._state;
        if (s.windowPicking || mode === s.windowMode)
            return;
        s.windowMode = mode;
        if (mode === 'once') {
            s.windowIndex = 0;
        } else if (mode === 'forever') {
            s.windowIndex = WINDOW_STOPS.length - 1;
        } else if (mode === 'timed' && s.remaining > 0) {
            // Only what is left is knowable, so land on the shortest stop that
            // could still be running.
            const minutes = s.remaining / 60;
            for (let i = 1; i < WINDOW_STOPS.length - 1; i++) {
                if (parseInt(WINDOW_STOPS[i].arg) >= minutes) {
                    s.windowIndex = i;
                    break;
                }
            }
        }
    }

    // "Not available" explains nothing; the command knows which piece is
    // absent, in a sentence written for someone holding a laptop.
    async _askDoctor() {
        this._busy.add('doctor');
        const result = await this._cli.run(['doctor', '--json']);
        this._busy.delete('doctor');
        if (this._destroyed)
            return;
        try {
            const missing = JSON.parse(result.stdout).missing || [];
            this._state.doctorText = missing.length ? missing[0].say : '';
            this._state.driverInstallable = missing.some(m => m.id === 'driver' || m.id === 'library');
        } catch {
            this._state.doctorText = '';
            this._state.driverInstallable = false;
        }
        this._render();
    }

    // The terminal it opens is the interface from here on; asking again when
    // it returns catches the case where they installed.
    async _installDriver() {
        this.menu.close();
        await this._cli.run(['install-driver']);
        if (this._destroyed)
            return;
        this._state.doctorText = '';
        this._refreshStatus();
    }

    // ----------------------------------------------------------- actions

    async _toggle() {
        const s = this._state;
        if (s.busy || !this._usable)
            return;
        s.turningOn = !s.receiving;
        s.busy = true;
        s.lastError = '';
        this._render();
        const result = await this._cli.run(['toggle', this._windowArg]);
        if (this._destroyed)
            return;
        s.busy = false;
        // A refusal is the interesting case: the command declines rather
        // than pretending, and its sentence is what the person needs.
        s.lastError = result.ok ? '' : result.stderr.trim();
        this._refreshStatus();
        this._render();
    }

    _sliderMoved() {
        if (this._sliderSync)
            return;
        const s = this._state;
        const index = Math.round(this._slider.value * (WINDOW_STOPS.length - 1));
        s.windowIndex = index;
        // A drag reports through drag-end; a key or scroll has no end, so it
        // is taken once it has rested for a moment.
        if (!this._sliderDragging) {
            s.windowPicking = true;
            this._once('sliderRest', 600, () => this._sliderReleased());
        }
        this._windowValue.text = this._windowValueText;
    }

    // On release, not per stop: each change re-arms the window timer and
    // rewrites the radio's deadline. A live window is reset to the new
    // choice, counting from now.
    async _sliderReleased() {
        this._stopTimer('sliderRest');
        const s = this._state;
        s.windowIndex = Math.round(this._slider.value * (WINDOW_STOPS.length - 1));
        s.windowPicking = false;
        this._setSlider(s.windowIndex);
        const arg = this._windowArg;
        this._render();
        await this._cli.run(['window', arg]);
        if (this._destroyed || !s.receiving || s.busy || !this._usable)
            return;
        s.windowMode = arg === 'once' || arg === 'forever' ? arg : 'timed';
        s.lastError = '';
        const result = await this._cli.run(['on', arg]);
        if (this._destroyed)
            return;
        s.lastError = result.ok ? '' : result.stderr.trim();
        this._refreshStatus();
    }

    // The command and the receiver validate the name, not this: a refused
    // name is put back and the command's message shown. One asked for while
    // an earlier one is being applied goes next.
    _setDeviceName(name) {
        const s = this._state;
        if (name.trim() === '' || name === this._shownName)
            return;
        s.pendingName = name;
        if (!this._busy.has('name'))
            this._applyName();
    }

    async _applyName() {
        const s = this._state;
        this._busy.add('name');
        while (s.pendingName !== '' && s.pendingName !== s.sentName) {
            s.sentName = s.pendingName;
            const result = await this._cli.run(['name', s.sentName]);
            if (this._destroyed)
                return;
            s.lastError = result.ok ? '' : result.stderr.trim();
        }
        this._busy.delete('name');
        s.pendingName = '';
        s.sentName = '';
        this._refreshStatus();
    }

    async _pickDownloadDir() {
        const s = this._state;
        if (s.pickingDir)
            return;
        s.pickingDir = true;
        s.lastError = '';
        this._render();
        // The menu holds the pointer and keyboard, so it steps aside while the
        // chooser is open and comes back with the answer.
        this.menu.close();
        const title = 'Save received files to';
        this._raiseChooser(title);
        const result = await this._cli.run(['dir', '--pick']);
        if (this._destroyed)
            return;
        this._cancelRaise();
        s.pickingDir = false;
        if (result.stderr.trim() !== '')
            s.lastError = result.stderr.trim();
        this.menu.open();
        this._refreshStatus();
    }

    async _setAudience(mode) {
        const s = this._state;
        if (mode === s.audience || this._busy.has('audience'))
            return;
        s.audience = mode;
        this._busy.add('audience');
        this._render();
        await this._cli.run(['visibility', mode]);
        this._busy.delete('audience');
        if (!this._destroyed)
            this._refreshStatus();
    }

    async _toggleSound() {
        const s = this._state;
        s.soundOn = !s.soundOn;
        this._busy.add('sound');
        this._render();
        await this._cli.run(['sound', s.soundOn ? 'on' : 'off']);
        this._busy.delete('sound');
        if (!this._destroyed)
            this._refreshStatus();
    }

    // The receiver rereads the list on every request, so a change applies to
    // the next transfer with no restart.
    _toggleSenders() {
        const s = this._state;
        s.sendersOpen = !s.sendersOpen;
        s.senderError = '';
        if (s.sendersOpen)
            this._refreshSenders();
        this._render();
    }

    async _refreshSenders() {
        const result = await this._cli.run(['senders', 'list', '--json']);
        if (this._destroyed)
            return;
        try {
            this._state.senderList = JSON.parse(result.stdout);
        } catch {
            return;
        }
        this._senderRows.removeAll();
        for (const id of this._state.senderList) {
            const row = new ActionItem(() => this._editSenders(['remove', id], false), {style_class: 'omdrop-sender-row'});
            row.add_child(new St.Label({text: id, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(new St.Icon({icon_name: 'window-close-symbolic', style_class: 'omdrop-small-icon', opacity: DIM}));
            row.accessible_name = `Remove ${id}`;
            this._senderRows.addMenuItem(row);
        }
        this._render();
    }

    _addSender(id) {
        id = id.trim();
        if (id !== '')
            this._editSenders(['add', id], true);
    }

    // The command validates, so the panel shows its sentence rather than
    // keeping a second copy of the rules.
    async _editSenders(args, clearField) {
        if (this._busy.has('senders'))
            return;
        this._busy.add('senders');
        const result = await this._cli.run(['senders', ...args]);
        this._busy.delete('senders');
        if (this._destroyed)
            return;
        if (result.ok) {
            this._state.senderError = '';
            if (clearField)
                this._senderEntry.set_text('');
        } else {
            this._state.senderError = result.stderr.trim().replace(/^omdrop: /, '');
        }
        this._refreshSenders();
        this._refreshStatus();
    }

    // ------------------------------------------------------------- radar

    // Scanning is what a window does, so opening the radar on a machine that
    // is off opens one, for as long as the slider says.
    _openRadar() {
        const s = this._state;
        s.radarOpen = !s.radarOpen;
        if (s.radarOpen && this._usable && !s.receiving && !s.busy)
            this._toggle();
        this._render();
    }

    // Two listings run while the radar is open. The bare one is passive and
    // quick, so it is polled for the dots and their signal. The named one
    // connects to every peer and takes half a minute, so it runs back to back,
    // and the names it finds are kept for the session: a device answers only
    // while its AirDrop is listening.
    _updateScanning() {
        const scanning = this._scanningNow;
        if (scanning === this._scanning)
            return;
        this._scanning = scanning;
        this._radar.setScanning(scanning);
        if (scanning) {
            this._pollPeers();
            this._timer('peers', 2000, () => this._pollPeers());
            this._runNames();
        } else {
            this._stopTimer('peers');
            this._stopTimer('namesAgain');
            // A radar that has been closed should not keep broadcasting.
            Cli.stop(this._namesProc);
        }
    }

    async _pollPeers() {
        if (this._busy.has('peers'))
            return;
        this._busy.add('peers');
        const result = await this._cli.run(['peers', '--json']);
        this._busy.delete('peers');
        if (this._destroyed || !this._scanning)
            return;
        // An empty room still prints [], with a sentence on stderr.
        let list;
        try {
            list = JSON.parse(result.stdout);
        } catch {
            return;
        }
        if (Array.isArray(list))
            this._mergePeers(list);
    }

    _runNames() {
        if (!this._scanning || this._namesProc)
            return;
        const startedAt = GLib.get_monotonic_time();
        const {proc, done} = this._cli.stream(['peers', '--json', '-n', '--stream'], {
            onStdout: line => {
                try {
                    this._learnName(JSON.parse(line));
                } catch {
                    // Not one of its lines.
                }
            },
        });
        this._namesProc = proc;
        done.then(() => {
            this._namesProc = null;
            if (this._destroyed)
                return;
            // One that fails at once would otherwise restart in a tight loop;
            // one that ran to its end has answered, names or not.
            const quick = GLib.get_monotonic_time() - startedAt < 5e6;
            if (!quick) {
                this._state.namesResolved = true;
                this._render();
            }
            if (this._scanning)
                this._once('namesAgain', quick ? 10000 : 250, () => this._runNames());
        });
    }

    _mergePeers(list) {
        this._state.peers = list.map(p => ({mac: p.mac, rssi: p.rssi, name: p.name || this._peerNames.get(p.mac) || ''}));
        this._radar.setPeers(this._state.peers);
        this._render();
    }

    // Streamed a line per peer the moment it answers, so a name appears
    // seconds after it arrives rather than when the slowest peer gives up.
    _learnName(p) {
        if (!p || !p.mac || !p.name)
            return;
        if (this._peerNames.get(p.mac) !== p.name) {
            this._peerNames.set(p.mac, p.name);
            this._mergePeers(this._state.peers);
        }
        this._state.namesResolved = true;
        this._render();
    }

    // Rows are kept in place across polls, keyed by address: one is created
    // when its device arrives and removed when it leaves, so a click never
    // lands on a row that was rebuilt under the pointer.
    _syncPeerRows(named) {
        const want = new Map(named.map(p => [p.mac, p.name || '']));
        for (const [mac, row] of this._rows) {
            if (!want.has(mac)) {
                row.item.destroy();
                this._rows.delete(mac);
            }
        }
        for (const [mac, name] of want) {
            let row = this._rows.get(mac);
            if (!row) {
                row = this._peerRow(mac);
                this._rows.set(mac, row);
                this._peerRowsSection.addMenuItem(row.item);
                // A flash that fades, the first time this device appears.
                if (!this._flashed.has(mac)) {
                    this._flashed.add(mac);
                    row.item.add_style_class_name('omdrop-peer-flash');
                    this._once(`flash-${mac}`, 140, () => row.item.remove_style_class_name('omdrop-peer-flash'));
                }
            }
            this._updatePeerRow(row, mac, name);
        }
    }

    _peerRow(mac) {
        const item = new ActionItem(() => this._sendTo(mac), {style_class: 'omdrop-peer'});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const top = new St.BoxLayout({x_expand: true});
        const name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'omdrop-peer-name'});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const macLabel = new St.Label({style_class: 'omdrop-caption', y_align: Clutter.ActorAlign.CENTER, opacity: DIM});
        top.add_child(name);
        top.add_child(macLabel);
        column.add_child(top);

        const statusRow = new St.BoxLayout({x_expand: true});
        const status = wrappingLabel('omdrop-caption omdrop-peer-status');
        statusRow.add_child(status);
        // Cancels a send under way; dismisses a failure once it is read.
        const cancel = new St.Button({
            child: new St.Icon({icon_name: 'window-close-symbolic', style_class: 'omdrop-small-icon'}),
            style_class: 'omdrop-cancel', can_focus: true, y_align: Clutter.ActorAlign.START,
        });
        cancel.connect('clicked', () => (this._state.sendFailed ? this._dismissSend() : this._cancelSend()));
        statusRow.add_child(cancel);
        column.add_child(statusRow);

        // Progress, honestly: the sender reports stages, not bytes, so a
        // sliding segment says "working" and the bar fills when it arrives.
        const track = new St.Widget({style_class: 'omdrop-track', x_expand: true, clip_to_allocation: true});
        const segment = new St.Widget({style_class: 'omdrop-track-fill'});
        const fill = new St.Widget({style_class: 'omdrop-track-fill'});
        track.add_child(segment);
        track.add_child(fill);
        track.connect('notify::width', () => {
            segment.set_size(track.width * 0.3, track.height);
            fill.set_size(track.width, track.height);
        });
        column.add_child(track);
        item.add_child(column);
        return {item, name, macLabel, statusRow, status, cancel, track, segment, fill, sliding: false};
    }

    _updatePeerRow(row, mac, name) {
        const s = this._state;
        const target = s.sendingTo === mac;
        row.name.text = name || mac;
        row.name.remove_style_class_name('omdrop-bold');
        if (target)
            row.name.add_style_class_name('omdrop-bold');
        row.macLabel.text = mac;
        row.macLabel.visible = name !== '';
        row.item.accessible_name = `Send a file to ${name || mac}`;
        row.statusRow.visible = target && s.sendStatus !== '';
        row.status.text = s.sendStatus;
        this._setUrgent(row.status, s.sendFailed, 220);
        row.cancel.visible = this._sendActive || (s.sendFailed && !this._sendRunning);
        row.cancel.accessible_name = s.sendFailed ? 'Dismiss' : 'Cancel the send';
        row.track.visible = target && (this._sendActive || s.sendDone);
        row.fill.visible = s.sendDone;
        const slide = target && this._sendActive;
        row.segment.visible = slide;
        if (slide && !row.sliding) {
            row.sliding = true;
            const run = () => {
                if (!row.sliding)
                    return;
                row.segment.translation_x = -row.segment.width;
                row.segment.ease({
                    translation_x: row.track.width, duration: 1100, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: run,
                });
            };
            run();
        } else if (!slide && row.sliding) {
            row.sliding = false;
            row.segment.remove_all_transitions();
        }
    }

    // -------------------------------------------------------------- send

    // One send at a time, owned here so it survives the menu closing while
    // the chooser has the keyboard. The command opens the chooser where the
    // last file came from, and narrates the transfer one line at a time.
    _sendTo(mac) {
        const s = this._state;
        if (this._sendRunning)
            return;
        const named = s.peers.find(p => p.mac === mac);
        Object.assign(s, {
            sendingTo: mac, sendingName: named ? named.name : '', sendStatus: 'Choose files…',
            sendChosen: false, sendFailed: false, sendDone: false, sendCancelled: false, sendingFile: '',
        });
        this._stopTimer('sendClose');
        this._raiseChooser(`Send to ${mac}`);
        const peerLabel = () => this._peerNames.get(s.sendingTo) || s.sendingName || s.sendingTo;
        const {proc, done} = this._cli.stream(['send', '--pick', '--to', mac], {
            onStdout: line => {
                line = line.trim();
                if (line === '')
                    return;
                if (!s.sendChosen) {
                    s.sendChosen = true;
                    this._cancelRaise();
                    this.menu.open();
                }
                const chosen = /^Preparing (.*)\.\.\.$/.exec(line);
                if (chosen)
                    s.sendingFile = chosen[1];
                s.sendStatus = line;
                this._render();
            },
            // Line by line too: the wait for a device's receiver is progress,
            // and the last line is the reason a failure failed. Ports and
            // paths become simply the file on its way.
            onStderr: line => {
                line = line.trim();
                if (line === '')
                    return;
                const sending = /^sending (.*) to \S+ at /.exec(line);
                if (sending || /^waiting up to \d+s for .* to start listening/.test(line)) {
                    const file = s.sendingFile || (sending ? sending[1].replace(/^.*\//, '') : 'the file');
                    line = `Sending ${file} to ${peerLabel()}...`;
                }
                s.sendStatus = line;
                this._render();
            },
        });
        this._sendProc = proc;
        // Out of the chooser's way, and back when it answers. Only now that
        // the send is running, so closing does not fold the radar away.
        this.menu.close();
        this._render();
        done.then(code => {
            this._sendProc = null;
            if (this._destroyed)
                return;
            this._cancelRaise();
            this.menu.open();
            // A cancelled chooser is exit 1 with nothing said, and a send the
            // person cancelled is not a failure: the row is just a row again.
            if (s.sendCancelled || (code !== 0 && !s.sendChosen && s.sendStatus === 'Choose files…')) {
                Object.assign(s, {sendCancelled: false, sendingTo: '', sendStatus: ''});
                this._render();
                return;
            }
            s.sendFailed = code !== 0;
            s.sendDone = code === 0;
            // Long enough to read "Sent photo.jpg", then out of the way.
            if (s.sendDone) {
                this._once('sendClose', 1800, () => {
                    Object.assign(s, {sendingTo: '', sendStatus: '', sendDone: false});
                    this._render();
                    this.menu.close();
                });
            }
            this._render();
        });
    }

    // The command stops the sender's whole process group on TERM, so nothing
    // goes on knocking on the device's door after this.
    _cancelSend() {
        if (!this._sendRunning)
            return;
        this._state.sendCancelled = true;
        this._state.sendStatus = 'Cancelling…';
        Cli.stop(this._sendProc);
        this._render();
    }

    _dismissSend() {
        if (this._sendRunning)
            return;
        Object.assign(this._state, {sendFailed: false, sendingTo: '', sendStatus: ''});
        this._render();
    }

    // A chooser started from here has no parent window and no activation
    // token, so GNOME would leave it behind whatever has focus. Watch for the
    // window with the title the command gave it, and bring it forward.
    _raiseChooser(title) {
        this._cancelRaise();
        this._raiseWatches = [];
        const tryWindow = win => {
            if (win.get_title() !== title)
                return false;
            Main.activateWindow(win);
            this._cancelRaise();
            return true;
        };
        this._raiseCreated = global.display.connect('window-created', (_d, win) => {
            if (tryWindow(win))
                return;
            const id = win.connect('notify::title', () => tryWindow(win));
            this._raiseWatches.push([win, id]);
        });
        this._once('raise', 30000, () => this._cancelRaise());
    }

    _cancelRaise() {
        if (this._raiseCreated) {
            global.display.disconnect(this._raiseCreated);
            this._raiseCreated = 0;
        }
        for (const [win, id] of this._raiseWatches ?? []) {
            try {
                win.disconnect(id);
            } catch {
                // The window is gone.
            }
        }
        this._raiseWatches = [];
        this._stopTimer('raise');
    }

    // ------------------------------------------------------- open, keys

    // Opening shows the truth immediately. Send to peers opens only when
    // asked, so it collapses whenever the menu closes -- except when the
    // menu has only stepped aside for a chooser.
    _openChanged(open) {
        const s = this._state;
        if (open && !s.busy)
            this._refreshStatus();
        if (!open && !this._sendRunning && !s.pickingDir)
            s.radarOpen = false;
        this._armResync();
        this._render();
    }

    // d turns Omdrop on or off, n opens the radar -- unless a text field
    // has the keyboard, which then gets every key.
    _onKey(event) {
        if (global.stage.get_key_focus() instanceof Clutter.Text)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_d || key === Clutter.KEY_D) {
            this._toggle();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_n || key === Clutter.KEY_N) {
            this._openRadar();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // A right click on the icon turns Omdrop on or off without opening the menu.
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._toggle();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _teardown() {
        this._destroyed = true;
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        this._cancelRaise();
        this._cli.destroy();
    }
});

export default class OmdropExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        // Received files go on the clipboard through here: Mutter offers
        // background programs no way to set it, and GNOME Shell owns it.
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    CopyText(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    // Images only, from a regular file of a sane size: the caller is the
    // omdrop command handing over something that just arrived.
    CopyFile(path, mimeType) {
        if (!CLIPBOARD_IMAGE_TYPES.includes(mimeType))
            throw new Error(`Not an image type the clipboard takes here: ${mimeType}`);
        if (!GLib.path_is_absolute(path) || !GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            throw new Error(`Not a file: ${path}`);
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        if (size > CLIPBOARD_MAX_BYTES)
            throw new Error(`Too large for the clipboard: ${path}`);
        const [, contents] = file.load_contents(null);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mimeType, new GLib.Bytes(contents));
    }
}
