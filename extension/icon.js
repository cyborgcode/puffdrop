// The icon while Puffdrop is on: the AirDrop mark drawn live. GNOME Shell does
// not play SVG animation, so this redraws the project's animated SVG with
// Cairo, on the same 24-unit grid as icons/puffdrop-symbolic.svg. Each arc
// keeps its opening at the bottom; a small gap opens at one end of the arc,
// travels counterclockwise to the other end and closes, then the arc rests
// whole until the next pass, all within 1.5 s.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const TURN_MS = 1500;
const CX = 12, CY = 10.79;
// Each arc as the SVG draws it: a circle measured in 360 units from `rotate`
// degrees (clockwise, from three o'clock), stroked for `length` units. Part A
// runs from the start and shrinks to nothing by `aEnd`; part B ends where the
// arc ends and grows back from `bStart` to `bEnd`, the whole arc again. The
// space between them is the travelling gap. Times are fractions of a turn.
const ARCS = [
    {r: 8.79, rotate: 132, length: 276, aEnd: 0.766667, bStart: 0.055556, bEnd: 0.822222},
    {r: 5.49, rotate: 139, length: 262, aEnd: 0.727778, bStart: 0.088889, bEnd: 0.815556},
];

// The pieces of one arc at time t, as [from, to] in its 360 units.
function arcPieces(arc, t) {
    const pieces = [];
    if (t < arc.aEnd)
        pieces.push([0, arc.length * (1 - t / arc.aEnd)]);
    else if (t >= arc.bEnd)
        pieces.push([0, arc.length]);
    if (t >= arc.bStart && t < arc.bEnd) {
        const grown = (t - arc.bStart) / (arc.bEnd - arc.bStart);
        pieces.push([arc.length * (1 - grown), arc.length]);
    }
    return pieces;
}
const HUB = 'M14.1297 11.3386C14.5197 9.69856 13.0897 8.26856 11.4497 8.65856C10.6797 8.84856 10.0497 9.47856 ' +
    '9.85974 10.2486C9.46974 11.8886 10.8997 13.3186 12.5397 12.9286C13.3197 12.7386 13.9497 12.1086 14.1297 11.3386Z';
const POINTER = 'M10.3009 16.66L8.86086 18.45C7.72086 19.88 8.74086 22 10.5609 22H13.4309C15.2609 22 16.2809 19.88 ' +
    '15.1309 18.46L13.6909 16.67C12.8309 15.57 11.1709 15.57 10.3009 16.66Z';

// The absolute M, L, H, C and Z commands the two shapes use.
function tracePath(cr, d) {
    const tokens = d.match(/[MLHCZ]|-?\d*\.?\d+/g);
    let i = 0, x = 0, y = 0, cmd = '';
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
        if (/[MLHCZ]/.test(tokens[i]))
            cmd = tokens[i++];
        switch (cmd) {
        case 'M': x = num(); y = num(); cr.moveTo(x, y); cmd = 'L'; break;
        case 'L': x = num(); y = num(); cr.lineTo(x, y); break;
        case 'H': x = num(); cr.lineTo(x, y); break;
        case 'C': {
            const c = [num(), num(), num(), num()];
            x = num(); y = num();
            cr.curveTo(c[0], c[1], c[2], c[3], x, y);
            break;
        }
        case 'Z': cr.closePath(); break;
        }
    }
}

export const AnimatedIcon = GObject.registerClass(
class PuffdropAnimatedIcon extends St.DrawingArea {
    _init(size, styleClass = '') {
        super._init({style_class: styleClass, width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
        this._timeline = new Clutter.Timeline({actor: this, duration: TURN_MS, repeat_count: -1});
        this._timeline.connect('new-frame', () => this.queue_repaint());
        this.connect('notify::visible', () => this._sync());
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._timeline.stop());
    }

    _sync() {
        if (this.visible && this.mapped)
            this._timeline.start();
        else
            this._timeline.stop();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [w, h] = this.get_surface_size();
            const fg = this.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255);
            const scale = Math.min(w, h) / 24;
            cr.translate((w - 24 * scale) / 2, (h - 24 * scale) / 2);
            cr.scale(scale, scale);

            tracePath(cr, HUB);
            cr.fill();
            tracePath(cr, POINTER);
            cr.fill();

            const t = this._timeline.is_playing() ? this._timeline.get_progress() : 1;
            cr.setLineWidth(1.5);
            cr.setLineCap(1); // Cairo.LineCap.ROUND
            const rad = deg => deg * Math.PI / 180;
            for (const arc of ARCS) {
                for (const [from, to] of arcPieces(arc, t)) {
                    if (to - from < 0.5)
                        continue;
                    cr.newSubPath();
                    cr.arc(CX, CY, arc.r, rad(arc.rotate + from), rad(arc.rotate + to));
                    cr.stroke();
                }
            }
        } finally {
            cr.$dispose();
        }
    }
});
