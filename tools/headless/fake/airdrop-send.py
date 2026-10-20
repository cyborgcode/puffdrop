#!/usr/bin/env python3
"""Stands in for the real sender's upload: writes 2 MB over about 4 s, which
is what the CLI's progress watcher measures."""
import os
import time
fd = os.open(os.devnull, os.O_WRONLY)
for _ in range(40):
    os.write(fd, b'x' * 50000)
    time.sleep(0.1)
