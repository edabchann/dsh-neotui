#!/usr/bin/env python3
# Real-pty reproduction: boot attach mode, click a session, scroll with SGR
# wheel sequences, resize the pty (SIGWINCH), and capture everything.
import os, pty, time, signal, fcntl, termios, struct, sys, json

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTHOME = os.path.join(REPO, ".testhome")
RAW = os.path.join(REPO, "test", "pty-crash.raw")

env = dict(os.environ)
env["DSH_HOME"] = TESTHOME

# Repair the ignored PTY profile fixture from source truth on every run. This
# prevents an old local fixture name (`dsh-tui-app`) from masking resolution.
profile_dir = os.path.join(TESTHOME, "profiles", "tui")
os.makedirs(profile_dir, exist_ok=True)
profile_package = os.path.join(profile_dir, "package.json")
profile_data = {
    "name": "dsh-profile-tui", "private": True, "dependencies": {},
    "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "dsh-neotui-app"]}},
}
with open(profile_package, "w", encoding="utf-8") as stream:
    json.dump(profile_data, stream, indent=2)
    stream.write("\n")
for filename, content in (("cordis.yml", "[]\n"), ("cordis.patch.yml", "[]\n"), ("pnpm-workspace.yaml", "packages: []\n")):
    path = os.path.join(profile_dir, filename)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(content)

# Keep the checked-in profile self-contained: dsh resolves bundle names from
# the profile directory, so expose both local packages through node_modules.
# Symlinks are recreated idempotently and never require a global npm install.
profile_modules = os.path.join(TESTHOME, "profiles", "tui", "node_modules")
os.makedirs(profile_modules, exist_ok=True)
for name, target in (("dsh-neotui-app", os.path.join(REPO, "app")), ("dsh-neotui", REPO)):
    link = os.path.join(profile_modules, name)
    if os.path.lexists(link) and not os.path.islink(link):
        raise RuntimeError(f"PTY fixture path is not a symlink: {link}")
    if os.path.islink(link) and os.path.realpath(link) != os.path.realpath(target):
        os.unlink(link)
    if not os.path.lexists(link):
        os.symlink(target, link, target_is_directory=True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(REPO)
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
open(RAW, "wb").write(b"".join(out))
print("captured", len(raw), "bytes")
print("fatal:", "fatal" in raw, "| TypeError:", "TypeError" in raw, "| RangeError:", "RangeError" in raw)
import re
m = re.search(r"(TypeError|RangeError|Error:).{0,160}", raw)
if m: print(m.group(0)[:200])
