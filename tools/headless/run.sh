#!/bin/bash
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export OUT=${OUT:-/tmp/puffdrop-headless}
W=$OUT/work
rm -rf "$W"; mkdir -p "$W"/{run,home,config,state} "$W/data/gnome-shell/extensions/unsafe@test"
chmod 700 "$W/run"
touch "$W/state/receiving"
E=$W/data/gnome-shell/extensions
ln -s "$ROOT/extension" "$E/puffdrop@cyborgcode.github.io"
cat > "$E/unsafe@test/metadata.json" <<'J'
{"uuid": "unsafe@test", "name": "unsafe", "description": "test only", "shell-version": ["50"]}
J
cat > "$E/unsafe@test/extension.js" <<'J'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class extends Extension { enable() { global.context.unsafe_mode = true; } disable() {} }
J
chmod +x "$HERE"/fake/* "$HERE"/shim/*
export HOME=$W/home XDG_CONFIG_HOME=$W/config XDG_DATA_HOME=$W/data XDG_CACHE_HOME=$W/home/.cache XDG_RUNTIME_DIR=$W/run
export STATE=$W/state OMDROP_DISCOVERABLE=$HERE/fake/omdrop-discoverable OMDROP_SENDER=$HERE/fake/send-to-peer OMDROP_PICKER=$HERE/fake/picker
export PATH=$HERE/shim:$ROOT/bin:$PATH DRIVE="python3 -I $HERE/drive.py"
unset WAYLAND_DISPLAY DISPLAY
exec dbus-run-session -- bash -c '
  dconf write /org/gnome/shell/enabled-extensions "[\"unsafe@test\", \"puffdrop@cyborgcode.github.io\"]"
  dconf write /org/gnome/shell/disable-user-extensions false
  dconf write /org/gnome/desktop/interface/color-scheme "\"prefer-dark\""
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1400x900 --wayland-display=puffdrop-headless \
    > "$OUT/shell.log" 2>&1 &
  shell=$!
  for i in $(seq 60); do $DRIVE eval 1 >/dev/null 2>&1 && break; sleep 0.5; done
  timeout 120 bash "$1"; rc=$?
  kill $shell; wait $shell 2>/dev/null
  exit $rc
' bash "$1"
