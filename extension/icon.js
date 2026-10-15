// The icon while Puffdrop is on: the AirDrop mark drawn live, with one gap in
// each arc turning counterclockwise, a turn every 1.5 s. GNOME Shell does not
// play SVG animation, so the animated icon is drawn here with Cairo, on the
// same 24-unit grid as icons/puffdrop-symbolic.svg.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const TURN_MS = 1500;
const CX = 12, CY = 10.79;
// Each arc: radius, and the gap's share of the circle, as in the source SVG.
const ARCS = [[8.79, 84 / 360], [5.49, 98 / 360]];
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

            // The gaps start centred at the bottom, over the pointer, and turn
            // counterclockwise: in Cairo's clockwise angles, decreasing.
            const turn = this._timeline.get_progress() * 2 * Math.PI;
            cr.setLineWidth(1.5);
            cr.setLineCap(1); // Cairo.LineCap.ROUND
            for (const [r, gap] of ARCS) {
                const centre = Math.PI / 2 - turn;
                const half = gap * Math.PI;
                cr.newSubPath();
                cr.arc(CX, CY, r, centre + half, centre - half + 2 * Math.PI);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    }
});
