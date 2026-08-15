#!/usr/bin/env python3
# Strict real-PTY attach lifecycle test. Exit 0 = pass/host-unavailable skip,
# exit 1 = terminal lifecycle or runtime failure. Capture is saved only on fail.
import os, pty, time, signal, fcntl, termios, struct, json, socket, select, re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTHOME = os.path.join(REPO, ".testhome")
FAIL_RAW = os.path.join(REPO, "test", "pty-crash.raw")
HOST, PORT = "127.0.0.1", 3080

try:
    with socket.create_connection((HOST, PORT), timeout=0.5):
        pass
except OSError:
    print(f"SKIP: live DSH host unavailable at http://{HOST}:{PORT}")
    raise SystemExit(0)

env = dict(os.environ)
env["DSH_HOME"] = TESTHOME
profile_dir = os.path.join(TESTHOME, "profiles", "tui")
os.makedirs(profile_dir, exist_ok=True)
with open(os.path.join(profile_dir, "package.json"), "w", encoding="utf-8") as stream:
    json.dump({"name": "dsh-profile-tui", "private": True, "dependencies": {}, "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "dsh-neotui-app"]}}}, stream, indent=2)
    stream.write("\n")
for filename, content in (("cordis.yml", "[]\n"), ("cordis.patch.yml", "[]\n"), ("pnpm-workspace.yaml", "packages: []\n")):
    path = os.path.join(profile_dir, filename)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(content)
profile_modules = os.path.join(profile_dir, "node_modules")
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
    os.execvpe("dsh", ["dsh", "--profile", "tui", "--attach", f"http://{HOST}:{PORT}"], env)

def set_size(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

def drain(seconds, out):
    end = time.time() + seconds
    while time.time() < end:
        readable, _, _ = select.select([fd], [], [], min(0.2, max(0, end - time.time())))
        if readable:
            try:
                data = os.read(fd, 65536)
                if not data: return False
                out.append(data)
            except OSError:
                return False
    return True

out = []
try:
    set_size(35, 100); drain(9, out)
    os.write(fd, b"\x1b[<0;6;2M\x1b[<0;6;2m"); drain(2, out)
    for _ in range(6): os.write(fd, b"\x1b[<65;40;10M")
    set_size(50, 120); drain(2, out)
    for _ in range(4): os.write(fd, b"\x1b[<64;40;10M")
    set_size(25, 90); drain(2, out)
    os.write(fd, b"\x11"); drain(3, out)
finally:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    deadline = time.time() + 1
    while time.time() < deadline:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done: break
        except ChildProcessError: break
        time.sleep(0.05)
    else:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    try: os.close(fd)
    except OSError: pass

raw_bytes = b"".join(out)
raw = raw_bytes.decode("utf-8", "replace")
# Cursor-addressed diff rendering inserts CSI sequences between nearly every
# glyph; strip control sequences before asserting visible application copy.
plain = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])", "", raw)
checks = {
    "alternate screen entered": "\x1b[?1049h" in raw,
    "alternate screen left": "\x1b[?1049l" in raw,
    "SGR mouse enabled": "\x1b[?1006h" in raw,
    "SGR mouse disabled": "\x1b[?1006l" in raw,
    "rendered DSH surface": ("Ctrl" in plain and "/home/" in plain and ("任务" in plain or "输入" in plain)),
    "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
}
failed = [name for name, ok in checks.items() if not ok]
print(f"captured {len(raw_bytes)} bytes")
for name, ok in checks.items(): print(f"{'PASS' if ok else 'FAIL'}: {name}")
if failed:
    with open(FAIL_RAW, "wb") as stream: stream.write(raw_bytes)
    print(f"FAILED; capture saved to {FAIL_RAW}")
    raise SystemExit(1)
print("PTY lifecycle PASS")
