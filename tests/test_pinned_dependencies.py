"""Everything this plugin installs has to be pinned to an exact revision.

A package name is not a revision: code installed by name can change after the
commit anyone reviewed. These tests read the install script `install-driver`
would run and insist the radio backend it builds is named by a full commit
SHA, that a failed checkout cannot fall through to a build, and that anything
else comes from Ubuntu's repositories through apt.
"""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OMDROP = ROOT / "bin" / "puffdrop"

# The terminal launcher is stubbed rather than run: the script it would be
# handed, `bash -c SCRIPT`, is printed instead, which is exactly the commands
# a user's terminal would execute.
SYSTEMD_RUN = """#!/bin/sh
while [ "${1#--}" != "$1" ]; do shift; done
[ "$1" = xdg-terminal-exec ] && shift
[ "$1" = bash ] && [ "$2" = -c ] && printf '%s\\n' "$3"
exit 0
"""


class PinnedDependencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        # Nothing is installed: no receiver library and no backend, which is
        # the state that makes the plugin emit its full build script.
        self.command("python3", "#!/bin/sh\nexit 1\n")       # receiver library missing
        self.command("systemctl", "#!/bin/sh\nexit 3\n")     # ufw inactive
        self.command("xdg-terminal-exec", "#!/bin/sh\nexit 0\n")
        self.command("systemd-run", SYSTEMD_RUN)
        self.env = os.environ.copy()
        self.env.update(PATH=f"{self.bin}:{self.env['PATH']}",
                        OMDROP_DISCOVERABLE="/nonexistent",
                        HOME=self.tmp.name)

    def command(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    def build_script(self):
        result = subprocess.run([OMDROP, "install-driver"], env=self.env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return OMDROP.read_text(), result.stdout

    def test_nothing_comes_from_arch(self):
        _, script = self.build_script()
        for arch in ("pacman", "makepkg", "yay -S", "paru -S", "aur.archlinux.org"):
            self.assertNotIn(arch, script)

    def test_the_receiver_library_comes_from_the_ubuntu_repositories(self):
        # Without it the receiver cannot start. Installed by exact package
        # name, never built.
        _, script = self.build_script()
        self.assertRegex(script, r"(?m)^sudo apt-get install -y python3-libarchive-c keyutils\b")

    def test_the_pinned_commit_is_a_full_sha_used_literally(self):
        source, script = self.build_script()
        declared = re.search(r"^BACKEND_COMMIT=([0-9a-f]{40})$", source, re.M)
        self.assertIsNotNone(declared, "BACKEND_COMMIT is not declared as a full SHA")
        self.assertRegex(script, rf"checkout --quiet --detach {declared.group(1)}$|"
                                 rf"checkout --quiet --detach {declared.group(1)}\n")

    def test_a_failed_checkout_never_falls_through_to_a_build(self):
        # Fail-closed: the script stops at its first failure, and the build
        # comes only after the checkout of the pinned commit.
        _, script = self.build_script()
        self.assertTrue(script.splitlines()[0].endswith("set -e") or "( set -e" in script, script)
        lines = script.splitlines()
        checkout = next(i for i, l in enumerate(lines) if re.search(r"checkout .*--detach [0-9a-f]{40}", l))
        build = next(i for i, l in enumerate(lines) if "tools/build-deb.sh" in l)
        install = next(i for i, l in enumerate(lines) if re.search(r"apt-get install -y .*omdrop-owl_\*\.deb", l))
        self.assertLess(checkout, build)
        self.assertLess(build, install)


if __name__ == "__main__":
    unittest.main()
