// The radar under "Send to peers": every device the radio hears is a dot,
// brighter and nearer the centre for a stronger signal (not a direction or a
// distance), and a named one pings as the sweep passes it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

const SWEEP_MS = 4000;
const TRAIL_DEGREES = 70;
const MAX_VOICES = 3;

// Where a device sits around the scope: fixed per address, so a dot keeps its
// place from one listing to the next.
function bearingFor(mac) {
    let hash = 0;
    for (let i = 0; i < mac.length; i++)
        hash = (hash * 31 + mac.charCodeAt(i)) >>> 0;
    return hash % 360;
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

const Scope = GObject.registerClass(
class OmdropScope extends St.DrawingArea {
    _init(radar) {
        super._init({style_class: 'omdrop-radar-scope', reactive: true, x_expand: true, y_expand: true});
        this._radar = radar;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            this._radar.paint(cr, this);
        } finally {
            cr.$dispose();
        }
    }
});

export const Radar = GObject.registerClass({
    Signals: {
        'peer-clicked': {param_types: [GObject.TYPE_STRING]},
        'mute-toggled': {},
    },
}, class OmdropRadar extends St.Widget {
    _init(soundDir) {
        super._init({
            style_class: 'omdrop-radar',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._soundDir = soundDir;
        this._scanning = false;
        this._muted = false;
        this._contacts = new Map();     // mac -> contact, in arrival order
        this._labels = new Map();       // mac -> {x, y, width, height}
        this._hot = null;
        this._sweep = 0;
        this._previousSweep = -1;
        this._lastFrame = 0;
        this._voices = [];

        this._scope = new Scope(this);
        this.add_child(this._scope);

        // Quiet by design: a small outline in the corner that stays out of the
        // scope's way and comes forward only under the pointer.
        this._muteIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', style_class: 'omdrop-radar-mute-icon'});
        this._muteButton = new St.Button({
            style_class: 'omdrop-radar-mute',
            child: this._muteIcon,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            opacity: 77,
            accessible_name: 'Mute radar sound',
        });
        this._muteButton.connect('notify::hover', () => this._fadeMute());
        this._muteButton.connect('key-focus-in', () => this._fadeMute());
        this._muteButton.connect('key-focus-out', () => this._fadeMute());
        this._muteButton.connect('clicked', () => this.emit('mute-toggled'));
        this.add_child(this._muteButton);

        this._timeline = new Clutter.Timeline({actor: this, duration: SWEEP_MS, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame());

        this._scope.connect('motion-event', (_a, event) => {
            const [x, y] = event.get_coords();
            const [ok, lx, ly] = this._scope.transform_stage_point(x, y);
            if (ok)
                this._setHot(this._contactAt(lx, ly));
            return Clutter.EVENT_PROPAGATE;
        });
        this._scope.connect('leave-event', () => {
            this._setHot(null);
            return Clutter.EVENT_PROPAGATE;
        });
        this._scope.connect('button-release-event', () => {
            if (this._hot) {
                this.emit('peer-clicked', this._hot);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._scope.connect('notify::size', () => this._layoutLabels());
        this.connect('notify::mapped', () => this._activeChanged());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._stopSounds();
        });
    }

    get _active() {
        return this.mapped && this._scanning;
    }

    setScanning(scanning) {
        if (this._scanning === scanning)
            return;
        this._scanning = scanning;
        this._activeChanged();
    }

    setMuted(muted) {
        this._muted = muted;
        this._muteIcon.icon_name = muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
        this._muteButton.accessible_name = muted ? 'Unmute radar sound' : 'Mute radar sound';
        if (muted)
            this._stopSounds();
    }

    // A merged, successful snapshot from the panel. A failed poll never
    // arrives here as [], so an empty list really is an empty room.
    setPeers(peers) {
        const seen = new Set();
        let added = false;
        for (const peer of peers ?? []) {
            if (!peer || typeof peer.mac !== 'string' || !peer.mac)
                continue;
            const mac = peer.mac.toLowerCase();
            if (seen.has(mac))
                continue;
            seen.add(mac);
            const known = typeof peer.rssi === 'number' && Number.isFinite(peer.rssi);
            const strength = known ? Math.max(0, Math.min(1, (peer.rssi + 90) / 60)) : 0;
            const name = typeof peer.name === 'string' ? peer.name : '';
            let c = this._contacts.get(mac);
            // The blip marks a name arriving, on a new dot or one already drawn.
            if (!c) {
                c = {mac, bearing: bearingFor(mac), entrance: 0, alpha: 0, flare: 0, x: null, y: null};
                this._contacts.set(mac, c);
                if (name)
                    added = true;
            } else if (name && !c.name) {
                added = true;
            }
            Object.assign(c, {name, strength, known, present: true});
        }
        for (const c of this._contacts.values()) {
            if (!seen.has(c.mac)) {
                c.present = false;
                this._stopContactSound(c.mac);
            }
        }
        if (added)
            this._play('blip.wav', 0.55, '');
        this._layoutLabels();
        this._kick();
    }

    // Where the dot is headed, in scope coordinates.
    _target(c, w, h) {
        const radius = this._radius(w, h);
        const fraction = c.known ? 0.92 - 0.74 * c.strength : 0.96;
        const rad = c.bearing * Math.PI / 180;
        return [w / 2 + Math.sin(rad) * radius * fraction, h / 2 - Math.cos(rad) * radius * fraction];
    }

    _radius(w, h) {
        return Math.max(0, Math.min(w, h) / 2 - 8);
    }

    _activeChanged() {
        this._previousSweep = -1;
        if (!this._active)
            this._stopSounds();
        this._kick();
    }

    // Frames run while the sweep turns, or while a dot is still easing in or
    // out; otherwise the scope is drawn once and left alone.
    _kick() {
        if (!this.mapped) {
            this._timeline.stop();
            this._settle();
            return;
        }
        if (!this._timeline.is_playing()) {
            this._lastFrame = GLib.get_monotonic_time();
            this._timeline.start();
        }
        this._scope.queue_repaint();
    }

    _settle() {
        for (const [mac, c] of this._contacts) {
            if (!c.present)
                this._contacts.delete(mac);
        }
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.1, (now - this._lastFrame) / 1e6);
        this._lastFrame = now;
        const [w, h] = this._scope.get_size();
        let animating = false;

        for (const [mac, c] of this._contacts) {
            const [tx, ty] = this._target(c, w, h);
            if (c.x === null) {
                c.x = tx;
                c.y = ty;
            }
            // About 400 ms to settle on a new signal strength.
            const k = 1 - Math.exp(-dt / 0.13);
            c.x += (tx - c.x) * k;
            c.y += (ty - c.y) * k;
            c.entrance = Math.min(1, c.entrance + dt / 0.22);
            const wantAlpha = c.present ? c.entrance : 0;
            c.alpha += Math.sign(wantAlpha - c.alpha) * Math.min(Math.abs(wantAlpha - c.alpha), dt / 0.2);
            c.flare = Math.max(0, c.flare - dt / 0.6);
            if (!c.present && c.alpha <= 0) {
                this._contacts.delete(mac);
                continue;
            }
            if (Math.abs(tx - c.x) > 0.5 || Math.abs(ty - c.y) > 0.5 || c.entrance < 1 ||
                c.alpha !== wantAlpha || c.flare > 0)
                animating = true;
        }

        if (this._active) {
            this._sweep = this._timeline.get_progress() * 360;
            this._advanceSweep(w, h);
        } else if (!animating) {
            this._timeline.stop();
        }
        this._scope.queue_repaint();
    }

    // Every dot the sweep crossed since the last frame pulses; a named one pings.
    _advanceSweep(w, h) {
        const current = (this._sweep + 360) % 360;
        const previous = this._previousSweep;
        this._previousSweep = current;
        if (previous < 0)
            return;
        const travelled = (current - previous + 360) % 360;
        if (travelled === 0)
            return;
        for (const c of this._contacts.values()) {
            if (!c.present || c.x === null)
                continue;
            const angle = (Math.atan2(c.x - w / 2, h / 2 - c.y) * 180 / Math.PI + 360) % 360;
            const distance = (angle - previous + 360) % 360;
            if (distance > 0 && distance <= travelled) {
                c.flare = 1;
                if (c.name)
                    this._play(`contact-${1 + Math.round(c.strength * 4)}.wav`, 0.55 + 0.45 * c.strength, c.mac);
            }
        }
    }

    _font(scale = 0.85) {
        const font = this._scope.get_theme_node().get_font().copy();
        font.set_size(Math.max(1, Math.round(font.get_size() * scale)));
        return font;
    }

    _measure(text) {
        const layout = this._scope.create_pango_layout(text);
        layout.set_font_description(this._font());
        const [width, height] = layout.get_pixel_size();
        return [width, height];
    }

    // Labels for named dots, strongest first, each on whichever side of its
    // dot it fits without overlapping another. Run when the snapshot or the
    // size changes, never per frame, and placed against where each dot is
    // headed rather than where it is mid-ease.
    _layoutLabels() {
        const [w, h] = this._scope.get_size();
        if (w <= 0 || h <= 0)
            return;
        const radius = this._radius(w, h);
        const ordered = [...this._contacts.values()].filter(c => c.present && c.name);
        ordered.sort((a, b) => b.strength - a.strength || Number(b.known) - Number(a.known) ||
            (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
        const placed = [];
        const positions = new Map();
        const inset = Math.max(0, radius - 5);
        const gap = 9, padX = 4, padY = 3;
        for (const c of ordered) {
            const [labelW, labelH] = this._measure(c.name);
            const [tx, ty] = this._target(c, w, h);
            const preferred = tx > w / 2 ? -1 : 1;
            const attempts = [[preferred, 0], [-preferred, 0],
                [-preferred, labelH + padY * 2], [-preferred, -labelH - padY * 2]];
            for (const [side, shift] of attempts) {
                const top = Math.max(h / 2 - inset + labelH / 2,
                    Math.min(ty - labelH / 2 + shift, h / 2 + inset - labelH * 1.5));
                const edgeY = Math.max(Math.abs(top - h / 2), Math.abs(top + labelH - h / 2));
                const halfChord = Math.sqrt(Math.max(0, inset * inset - edgeY * edgeY));
                const available = side > 0 ? w / 2 + halfChord - tx - gap : tx - gap - (w / 2 - halfChord);
                const width = Math.min(labelW, w * 0.42, available);
                if (width < Math.min(labelW, 24))
                    continue;
                const box = {x: side > 0 ? tx + gap : tx - gap - width, y: top, width, height: labelH, dx: 0, dy: 0};
                const collides = placed.some(o =>
                    box.x - padX < o.x + o.width + padX && box.x + box.width + padX > o.x - padX &&
                    box.y - padY < o.y + o.height + padY && box.y + box.height + padY > o.y - padY);
                if (!collides) {
                    // Kept relative to the dot, so the label travels with it.
                    box.dx = box.x - tx;
                    box.dy = box.y - ty;
                    positions.set(c.mac, box);
                    placed.push(box);
                    break;
                }
            }
        }
        this._labels = positions;
        this._scope.queue_repaint();
    }

    // Any dot can be sent to: a device need not have answered a name lookup
    // to accept a file, so its address is target enough.
    _contactAt(x, y) {
        let best = null, bestDistance = Infinity;
        for (const c of this._contacts.values()) {
            if (!c.present || c.x === null)
                continue;
            const label = this._labels.get(c.mac);
            if (label) {
                const lx = c.x + label.dx, ly = c.y + label.dy;
                if (x >= lx - 4 && x <= lx + label.width + 4 && y >= ly - 3 && y <= ly + label.height + 3)
                    return c.mac;
            }
            const d = Math.hypot(x - c.x, y - c.y);
            if (d <= 14 && d < bestDistance) {
                best = c.mac;
                bestDistance = d;
            }
        }
        return best;
    }

    _setHot(mac) {
        if (this._hot === mac)
            return;
        this._hot = mac;
        this._setCursor(mac !== null);
        this._scope.queue_repaint();
    }

    _setCursor(pointing) {
        this._scope.set_cursor_type(pointing ? Clutter.CursorType.POINTER : Clutter.CursorType.INHERIT);
    }

    paint(cr, area) {
        const [w, h] = area.get_surface_size();
        const fg = area.get_theme_node().get_foreground_color();
        const r = fg.red / 255, g = fg.green / 255, b = fg.blue / 255;
        const cx = w / 2, cy = h / 2;
        const radius = this._radius(w, h);
        const ink = alpha => cr.setSourceRGBA(r, g, b, alpha);

        cr.setLineWidth(1);
        for (let i = 1; i <= 3; i++) {
            ink(0.16);
            cr.newPath();
            cr.arc(cx, cy, radius * i / 3, 0, 2 * Math.PI);
            cr.stroke();
        }
        ink(0.10);
        cr.moveTo(cx - radius, cy + 0.5);
        cr.lineTo(cx + radius, cy + 0.5);
        cr.moveTo(cx + 0.5, cy - radius);
        cr.lineTo(cx + 0.5, cy + radius);
        cr.stroke();

        if (this._scanning) {
            // Clockwise from twelve o'clock, with its trail fading behind it.
            const lead = (this._sweep - 90) * Math.PI / 180;
            const steps = 35, step = TRAIL_DEGREES / steps * Math.PI / 180;
            for (let i = 0; i < steps; i++) {
                const t = i / steps;
                ink(0.25 * Math.pow(1 - t, 1.6));
                cr.newPath();
                cr.moveTo(cx, cy);
                cr.arc(cx, cy, radius, lead - (i + 1) * step, lead - i * step + 0.002);
                cr.closePath();
                cr.fill();
            }
            ink(1);
            cr.setLineWidth(1.5);
            cr.moveTo(cx, cy);
            cr.lineTo(cx + Math.cos(lead) * radius, cy + Math.sin(lead) * radius);
            cr.stroke();
        }

        const font = this._font();
        const contacts = [...this._contacts.values()].filter(c => c.x !== null);
        // Unnamed dots underneath, named ones above, the one under the pointer on top.
        contacts.sort((a, b) => (a.mac === this._hot) - (b.mac === this._hot) || Boolean(a.name) - Boolean(b.name));
        for (const c of contacts) {
            const hot = c.mac === this._hot;
            const alpha = c.alpha;
            const scale = 0.65 + 0.35 * c.entrance;
            ink(alpha * (c.known ? 0.06 + 0.16 * c.flare : 0.03 + 0.10 * c.flare));
            cr.newPath();
            cr.arc(c.x, c.y, (15 + c.flare * 8) / 2 * scale, 0, 2 * Math.PI);
            cr.fill();
            ink(alpha * (hot ? 1 : c.known ? Math.min(1, 0.35 + 0.5 * c.strength + 0.4 * c.flare) : 0.22 + 0.4 * c.flare));
            cr.newPath();
            cr.arc(c.x, c.y, 3 * scale, 0, 2 * Math.PI);
            cr.fill();

            const label = this._labels.get(c.mac);
            if (!c.name || !label || !c.present)
                continue;
            const lx = c.x + label.dx, ly = c.y + label.dy;
            if (hot) {
                ink(0.15);
                roundedRect(cr, lx - 4, ly - 3, label.width + 8, label.height + 6, 4);
                cr.fill();
            }
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(font);
            layout.set_text(c.name, -1);
            layout.set_width(Math.ceil(label.width) * Pango.SCALE);
            layout.set_ellipsize(Pango.EllipsizeMode.END);
            ink(alpha * (hot ? 1 : 0.72));
            cr.moveTo(lx, ly);
            PangoCairo.show_layout(cr, layout);
        }
    }

    _fadeMute() {
        const near = this._muteButton.hover || this._muteButton.has_key_focus();
        this._muteButton.ease({opacity: near ? 217 : 77, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Three voices; a saturated pool drops a crossing rather than delaying it.
    _play(file, volume, mac) {
        if (!this._active || this._muted || !this._soundDir)
            return;
        if (this._voices.length >= MAX_VOICES)
            return;
        let proc;
        try {
            proc = Gio.Subprocess.new(['/bin/sh', '-c',
                'if command -v pw-play >/dev/null 2>&1; then exec pw-play --volume "$2" "$1"; ' +
                'elif command -v paplay >/dev/null 2>&1; then exec paplay --volume "$3" "$1"; fi',
                'omdrop-sound', GLib.build_filenamev([this._soundDir, file]),
                String(volume), String(Math.round(volume * 65536))], Gio.SubprocessFlags.NONE);
        } catch {
            return;
        }
        const voice = {proc, mac};
        this._voices.push(voice);
        proc.wait_async(null, () => {
            this._voices = this._voices.filter(v => v !== voice);
        });
    }

    _stopContactSound(mac) {
        for (const v of this._voices) {
            if (v.mac === mac)
                v.proc.force_exit();
        }
    }

    _stopSounds() {
        for (const v of this._voices)
            v.proc.force_exit();
    }
});
