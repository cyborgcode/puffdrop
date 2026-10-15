# Headless panel test

Runs a private, headless GNOME Shell with the Puffdrop extension and a fake
radio backend, on its own D-Bus session and runtime directory, so the panel
can be driven and screenshotted without touching the desktop you are using.

    tools/headless/run.sh SCRIPT

SCRIPT runs inside that session with `$DRIVE eval JS`, `$DRIVE shot FILE.png`
and `$DRIVE wait SECONDS`. A helper extension puts the test shell in unsafe
mode so Eval and Screenshot answer. `shim/` stands in for systemctl, pkexec,
systemd-run and sudo, so nothing reaches the real system or asks for a
password; `fake/` is the radio backend and sender. Output goes to $OUT
(default /tmp/puffdrop-headless).
