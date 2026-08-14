#!/usr/bin/env python3
# Real-pty reproduction: boot attach mode, click a session, scroll with SGR
# wheel sequences, resize the pty (SIGWINCH), and capture everything.
import os, pty, time, signal, fcntl, termios, struct, sys

env = dict(os.environ)
env["DSH_HOME"] = "/home/edabchann/dsh/tui/.testhome"

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/home/edabchann/dsh/tui")
    os.execvpe("dsh", ["dsh", "--profile", "tui", "--attach", "http://127.0.0.1:3080"], env)

def set_size(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

out = []
import select
def drain(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
                out.append(data)
            except OSError:
                return False
    return True

set_size(35, 100)
time.sleep(9)          # boot + attach
os.write(fd, b"\x1b[<0;6;2M\x1b[<0;6;2m")   # click first session
drain(3)
for _ in range(12):
    os.write(fd, b"\x1b[<65;40;10M")          # wheel down
    drain(0.15)
set_size(50, 120)                              # grow
drain(3)
for _ in range(8):
    os.write(fd, b"\x1b[<64;40;10M")          # wheel up
    drain(0.15)
set_size(25, 90)                               # shrink
drain(3)
os.write(fd, b"\x1b[<65;40;10M")
drain(2)
os.write(fd, b"\x11")                          # Ctrl+Q
drain(2)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
raw = b"".join(out).decode("utf-8", "replace")
open("/home/edabchann/dsh/tui/test/pty-crash.raw", "wb").write(b"".join(out))
print("captured", len(raw), "bytes")
print("fatal:", "fatal" in raw, "| TypeError:", "TypeError" in raw, "| RangeError:", "RangeError" in raw)
import re
m = re.search(r"(TypeError|RangeError|Error:).{0,160}", raw)
if m: print(m.group(0)[:200])
