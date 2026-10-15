"""Evaluate JS in, and take screenshots of, the headless GNOME Shell."""
import sys
import time

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(path, iface, method, args, reply):
    return bus.call_sync("org.gnome.Shell", path, iface, method, args, GLib.VariantType(reply),
                         Gio.DBusCallFlags.NONE, 20000, None).unpack()


cmd = sys.argv[1]
if cmd == "eval":
    ok, out = call("/org/gnome/Shell", "org.gnome.Shell", "Eval", GLib.Variant("(s)", (sys.argv[2],)), "(bs)")
    print(("OK " if ok else "ERR ") + out)
    sys.exit(0 if ok else 1)
elif cmd == "shot":
    ok, path = call("/org/gnome/Shell/Screenshot", "org.gnome.Shell.Screenshot", "Screenshot",
                    GLib.Variant("(bbs)", (False, False, sys.argv[2])), "(bs)")
    print(("OK " if ok else "ERR ") + path)
elif cmd == "wait":
    time.sleep(float(sys.argv[2]))
