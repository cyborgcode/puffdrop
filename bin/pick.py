#!/usr/bin/env python3
"""Ask the person for a folder or files, in GNOME's file chooser, and print the paths.

    pick.py folder|files START_DIR TITLE

Prints the chosen folder's absolute path on one line, or each chosen file's
absolute path followed by a NUL, since a filename may hold a newline. Exits 0
with an answer, 1 when the person cancels, and 2 when no chooser can be shown
at all, with the reason on stderr.

Through the desktop portal, which GNOME routes to Nautilus's own chooser. A
chooser started from the panel has no parent window and no activation token,
so the GNOME Shell extension brings the window with our title to the front.
"""

import os
import signal
import sys
from urllib.parse import unquote, urlparse

import gi
from gi.repository import Gio, GLib

try:  # GLib 2.80 moved it; older PyGObject only has the deprecated spelling.
    gi.require_version("GLibUnix", "2.0")
    from gi.repository import GLibUnix
    signal_add = GLibUnix.signal_add
except (ImportError, ValueError):
    signal_add = GLib.unix_signal_add

PORTAL_PATH = "/org/freedesktop/portal/desktop"


def options(kind, start):
    opts = {
        "modal": GLib.Variant("b", False),
        "accept_label": GLib.Variant("s", "Select" if kind == "folder" else "Send"),
    }
    if kind == "folder":
        opts["directory"] = GLib.Variant("b", True)
    else:
        opts["multiple"] = GLib.Variant("b", True)
    if start and os.path.isdir(start):
        # A NUL-terminated byte string: the portal's type for a path.
        opts["current_folder"] = GLib.Variant("ay", os.fsencode(start) + b"\0")
    return opts


def paths_of(results):
    """The chosen local paths. A remote location has no path to send from."""
    paths = []
    for uri in results.get("uris") or []:
        u = urlparse(uri)
        if u.scheme == "file":
            paths.append(unquote(u.path))
    return paths


def run(bus, handle, start_call):
    """Run a chooser to its answer, closing it if we are told to stop.

    A panel that goes away (the shell reloads, or its process is killed) must
    not leave a chooser on screen whose answer nobody is waiting for. The
    signal is watched from the main loop: a Python handler cannot run while
    the thread sits inside a blocking D-Bus call, which is how the first draft
    hung on SIGTERM with the chooser still open.
    """
    loop = GLib.MainLoop()
    answer = {}

    def finish(paths=None, error=None):
        answer.update(paths=paths, error=error)
        loop.quit()

    def stop():
        bus.call("org.freedesktop.portal.Desktop", handle, "org.freedesktop.portal.Request", "Close",
                 None, None, Gio.DBusCallFlags.NONE, 2000, None,
                 lambda *_: finish(), None)
        GLib.timeout_add(2500, finish)
        return GLib.SOURCE_REMOVE

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal_add(GLib.PRIORITY_HIGH, sig, stop)
    start_call(finish)
    loop.run()
    if answer.get("error"):
        raise answer["error"]
    return answer.get("paths")


def via_portal(bus, kind, start, title):
    token = f"puffdrop_{os.getpid()}"
    sender = bus.get_unique_name()[1:].replace(".", "_")
    handle = f"{PORTAL_PATH}/request/{sender}/{token}"

    def start_call(finish):
        def on_response(_c, _s, _p, _i, _sig, params):
            response, results = params.unpack()
            finish(paths_of(results) if response == 0 else None)

        # Subscribed before the call, at the path the portal will use, so a
        # quick answer cannot arrive before anyone is listening.
        bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request",
                             "Response", handle, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
        opts = options(kind, start)
        opts["handle_token"] = GLib.Variant("s", token)

        def done(conn, res):
            try:
                conn.call_finish(res)
            except GLib.Error as e:
                finish(error=e)

        bus.call("org.freedesktop.portal.Desktop", PORTAL_PATH, "org.freedesktop.portal.FileChooser",
                 "OpenFile", GLib.Variant("(ssa{sv})", ("", title, opts)),
                 GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 10000, None, done)

    return run(bus, handle, start_call)


def main(argv):
    if len(argv) != 4 or argv[1] not in ("folder", "files"):
        print("usage: pick.py folder|files START_DIR TITLE", file=sys.stderr)
        return 2
    kind, start, title = argv[1], argv[2], argv[3]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    try:
        paths = via_portal(bus, kind, start, title)
    except GLib.Error as e:
        print(f"No file chooser is available: {e.message}", file=sys.stderr)
        return 2
    if not paths:
        return 1
    if kind == "folder":
        print(paths[0])
    else:
        sys.stdout.write("".join(p + "\0" for p in paths))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
