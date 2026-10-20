"""The receiver answers on AirDrop's own port as well as the announced one, so
another Puffdrop can reach it, and it reports how far an upload has got."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVE = ROOT / "bin" / "airdrop-serve.py"


def free_port():
    probe = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        probe.bind(("::", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


def accepts(port, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            socket.create_connection(("::1", port), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.2)
    return False


class ExtraPortTests(unittest.TestCase):
    def test_the_receiver_answers_on_both_ports(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "in").mkdir()
        (tmp / "config.toml").write_text(f'name = "Test"\ndownload_dir = "{tmp / "in"}"\n')
        announced, direct = free_port(), free_port()
        env = dict(os.environ, XDG_RUNTIME_DIR=str(tmp))
        proc = subprocess.Popen(
            [sys.executable, SERVE, "--iface", "lo", "--port", str(announced),
             "--also-port", str(direct), "--config", tmp / "config.toml", "--keys", tmp / "keys"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        self.assertTrue(accepts(announced), "nothing answered on the announced port")
        self.assertTrue(accepts(direct), "nothing answered on the extra port")


class UploadProgressTests(unittest.TestCase):
    def progress_class(self, directory):
        source = SERVE.read_text()
        start = source.index("PROGRESS_DIR = ")
        body = source[start:source.index("\nclass LimitedWriter:")]
        namespace = {}
        exec("import json, os, time\n" + body, namespace)
        namespace["PROGRESS_DIR"] = str(directory)
        namespace["PROGRESS_INTERVAL"] = 0
        return namespace["UploadProgress"]

    def test_progress_is_reported_while_writing_and_removed_after(self):
        directory = Path(tempfile.mkdtemp()) / "receiving"
        progress_cls = self.progress_class(directory)
        with tempfile.TemporaryFile() as target:
            progress = progress_cls(target, "T1", "Rayen's iPhone", ["IMG_1.HEIC"], 1000)
            report = directory / "T1.json"
            self.assertEqual(json.loads(report.read_text())["received"], 0)

            progress.write(b"x" * 400)

            info = json.loads(report.read_text())
            self.assertEqual((info["sender"], info["files"], info["received"], info["total"]),
                             ("Rayen's iPhone", ["IMG_1.HEIC"], 400, 1000))
            # Everything else is the target's: the receiver calls tell() and
            # fileno() on what it writes to.
            self.assertEqual(progress.tell(), 400)
            progress.close()
        self.assertFalse(report.exists())


if __name__ == "__main__":
    unittest.main()
