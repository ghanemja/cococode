#!/usr/bin/env python3
"""Drive coco's interactive UI in a pseudo-terminal and capture what is on screen.

Usage: drive.py <script.json>

The script is a JSON object:
  {
    "cwd": "/path",
    "env": {"NAME": "value"},
    "args": ["--base-url", "..."],
    "cols": 100, "rows": 30,
    "steps": [
      {"wait": "text to wait for", "timeout": 10},
      {"send": "hello\\r"},
      {"sleep": 0.3},
      {"snapshot": "label"}
    ]
  }

Each snapshot prints the rendered screen (as a terminal emulator would show it)
between marker lines, so a test can assert on real output rather than on
escape sequences. Requires the `pyte` package.
"""
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import fcntl

import pyte


def main() -> int:
    with open(sys.argv[1]) as fh:
        spec = json.load(fh)
    cols = spec.get("cols", 100)
    rows = spec.get("rows", 30)
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)

    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env.update(spec.get("env", {}))
        env["TERM"] = "xterm-256color"
        env.pop("NO_COLOR", None)
        os.chdir(spec["cwd"])
        launcher = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bin", "coco.js")
        os.execvpe("node", ["node", launcher] + spec.get("args", []), env)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    raw = bytearray()

    def pump(duration: float) -> bool:
        """Read output for up to `duration` seconds. Returns False once the child has exited."""
        end = time.time() + duration
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.extend(data)
            stream.feed(data)
        return True

    def text() -> str:
        return "\n".join(line.rstrip() for line in screen.display)

    status = 0
    alive = True
    for step in spec["steps"]:
        if "wait" in step:
            deadline = time.time() + step.get("timeout", 10)
            found = False
            while time.time() < deadline:
                if step["wait"] in text():
                    found = True
                    break
                alive = pump(0.1)
                if not alive and step["wait"] not in text():
                    break
            if not found and step["wait"] not in text():
                print(f"<<<TIMEOUT waiting for {step['wait']!r}>>>")
                print(text())
                print("<<<END>>>")
                status = 1
                break
        elif "send" in step:
            os.write(fd, step["send"].encode())
            alive = pump(step.get("after", 0.15))
        elif "sleep" in step:
            alive = pump(step["sleep"])
        elif "resize" in step:
            cols, rows = step["resize"]
            screen.resize(rows, cols)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            alive = pump(0.3)
        elif "snapshot" in step:
            pump(0.1)
            print(f"<<<SNAPSHOT {step['snapshot']} cursor={screen.cursor.y},{screen.cursor.x}>>>")
            print(text())
            print("<<<END>>>")

    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    if spec.get("dump_raw"):
        with open(spec["dump_raw"], "wb") as fh:
            fh.write(bytes(raw))
    return status


if __name__ == "__main__":
    sys.exit(main())
