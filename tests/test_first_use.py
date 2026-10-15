"""The first `puffdrop on` sets up a fresh install without being asked.

Issue 12: on a fresh install the panel's switch refused with "Run: omdrop
setup", but `omdrop` reaches PATH only through `setup` itself, so the command
it named was not found. The first use has to install the receiving service and
the command on its own.
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OMDROP = ROOT / "bin" / "puffdrop"

# A user systemd that knows a unit only once its file exists, and refuses to
# start anything, so the run stops right after setup with nothing left behind.
FAKE_SYSTEMCTL = """#!/bin/bash
unit="$XDG_CONFIG_HOME/systemd/user/airdrop-receiver.service"
case " $* " in
  *" cat "*)       [[ -f "$unit" ]] ;;
  *" is-active "*) echo inactive; exit 3 ;;
  *" start "*)     exit 1 ;;
  *)               exit 0 ;;
esac
"""


def fresh_env(home):
    fakebin = home / "fakebin"
    fakebin.mkdir()
    for name, body in (("systemctl", FAKE_SYSTEMCTL),
                       ("systemd-run", "#!/bin/sh\nexit 1\n"),
                       ("pkexec", "#!/bin/sh\nexit 1\n")):
        (fakebin / name).write_text(body)
        (fakebin / name).chmod(0o755)
    # Its own runtime directory: `on` takes the identity lock and
    # writes the window file there, and must never touch the real one.
    runtime = home / "run"
    runtime.mkdir(mode=0o700)
    return {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_BIN_HOME": str(home / ".local" / "bin"),
        "XDG_RUNTIME_DIR": str(runtime),
        "PATH": f"{fakebin}:{os.environ['PATH']}",
    }


class FirstUseTests(unittest.TestCase):
    def test_setup_lists_what_is_missing_as_sentences(self):
        # prereqs_missing gives "id<TAB>sentence" lines; the id is for the
        # panel, and setup printed it along with the sentence.
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            env = fresh_env(home)
            # No radio helper, whatever this machine has installed.
            env["OMDROP_DISCOVERABLE"] = "/nonexistent"
            result = subprocess.run([str(OMDROP), "setup"], env=env,
                                    capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr

            self.assertIn("Not ready to receive yet:", output)
            self.assertIn("  - The radio backend", output)
            self.assertNotIn("\t", output)

    def test_first_on_installs_the_service_and_the_command(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            env = fresh_env(home)
            result = subprocess.run([str(OMDROP), "on", "1m"], env=env,
                                    capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr

            self.assertNotIn("Run: puffdrop setup", output)
            self.assertTrue(
                (home / ".config/systemd/user/airdrop-receiver.service").is_file(), output)
            link = home / ".local/bin/puffdrop"
            self.assertEqual(link.resolve(), OMDROP.resolve(), output)


if __name__ == "__main__":
    unittest.main()
