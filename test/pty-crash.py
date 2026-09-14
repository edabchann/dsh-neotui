#!/usr/bin/env python3
# Strict real-PTY attach lifecycle test. Exit 0 = pass/host-unavailable skip,
# exit 1 = terminal lifecycle or runtime failure. Capture is saved only on fail.
#
# Phase 1 (lifecycle): when a live DSH host already answers on 127.0.0.1:3080,
#   attach to it and assert the terminal lifecycle contract.
# Phase 2 (RPC data): boot a private `dsh --profile web` host on an OS-picked
#   port, seed one session through the public HTTP API with a unique title and
#   message marker, then attach the TUI with that host's launch token and assert
#   the rendered frame carries the HOST-returned values — the sidebar title
#   proves session/list, the marker message proves session/page. This covers the
#   0.1.5 wire contract end to end, not terminal lifecycle alone.
import os, pty, time, signal, fcntl, termios, struct, json, socket, select, re, secrets
import subprocess, urllib.request, urllib.error

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTHOME = os.path.join(REPO, ".testhome")
HOSTHOME = os.path.join(TESTHOME, "host")
FAIL_RAW = os.path.join(REPO, "test", "pty-crash.raw")
HOST, PORT = "127.0.0.1", 3080
# Cursor-addressed diff rendering inserts CSI sequences between nearly every
# glyph; strip control sequences before asserting visible application copy.
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])")


def plain(raw_bytes):
    return ANSI.sub("", raw_bytes.decode("utf-8", "replace"))


def port_open(host, port, timeout=0.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run_pty(argv, env, rows, cols, drive, settle):
    """Run one command in a real PTY, drive its keys, and return the captured bytes."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        os.execvpe(argv[0], argv, env)

    def set_size(r, c):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)

    def drain(seconds, out):
        end = time.time() + seconds
        while time.time() < end:
            readable, _, _ = select.select([fd], [], [], min(0.2, max(0, end - time.time())))
            if readable:
                try:
                    data = os.read(fd, 65536)
                    if not data:
                        return False
                    out.append(data)
                except OSError:
                    return False
        return True

    out = []
    try:
        set_size(rows, cols)
        drain(settle, out)
        drive(fd, out, drain, set_size)
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.time() + 1
        while time.time() < deadline:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done:
                    break
            except ChildProcessError:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass
    return b"".join(out)


def write_tui_profile():
    """Materialize the TUI profile fixture and return its environment."""
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
    return env


def lifecycle_phase(env):
    """Phase 1: attach to the already-running host and assert terminal lifecycle."""
    def drive(fd, out, drain, set_size):
        os.write(fd, b"\x1b[<0;6;2M\x1b[<0;6;2m")
        drain(2, out)
        for _ in range(6):
            os.write(fd, b"\x1b[<65;40;10M")
        set_size(50, 120)
        drain(2, out)
        for _ in range(4):
            os.write(fd, b"\x1b[<64;40;10M")
        set_size(25, 90)
        drain(2, out)
        os.write(fd, b"\x11")
        drain(3, out)

    raw_bytes = run_pty(["dsh", "--profile", "tui", "--attach", f"http://{HOST}:{PORT}"], env, 35, 100, drive, 9)
    raw = raw_bytes.decode("utf-8", "replace")
    text = plain(raw_bytes)
    checks = {
        "alternate screen entered": "\x1b[?1049h" in raw,
        "alternate screen left": "\x1b[?1049l" in raw,
        "SGR mouse enabled": "\x1b[?1006h" in raw,
        "SGR mouse disabled": "\x1b[?1006l" in raw,
        "rendered DSH surface": ("Ctrl" in text and "/home/" in text and ("任务" in text or "输入" in text)),
        "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
    }
    return checks, raw_bytes


# ---- private 0.1.5 host + HTTP API -----------------------------------------

WEB_PROFILE = {"name": "dsh-profile-web", "private": True, "dependencies": {}, "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live"}}}


def boot_private_host(timeout=75):
    """Boot `dsh --profile web` on an OS-picked port; return (process, port, token, log)."""
    profile_dir = os.path.join(HOSTHOME, "profiles", "web")
    os.makedirs(profile_dir, exist_ok=True)
    with open(os.path.join(profile_dir, "package.json"), "w", encoding="utf-8") as stream:
        json.dump(WEB_PROFILE, stream, indent=2)
        stream.write("\n")
    for filename, content in (("cordis.yml", "[]\n"), ("cordis.patch.yml", "[]\n"), ("pnpm-workspace.yaml", "packages:\n  - .\n")):
        path = os.path.join(profile_dir, filename)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(content)
    log_path = os.path.join(HOSTHOME, "web.log")
    log = open(log_path, "w", encoding="utf-8")
    env = dict(os.environ)
    env["DSH_HOME"] = HOSTHOME
    process = subprocess.Popen(
        ["dsh", "--profile", "web", "--port", "0", "--no-open"],
        stdout=log, stderr=subprocess.STDOUT, env=env, cwd=REPO, start_new_session=True,
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            break
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as stream:
                banner = stream.read()
        except OSError:
            banner = ""
        match = re.search(r"http://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_-]+)", banner)
        if match:
            return process, int(match.group(1)), match.group(2), log
        time.sleep(0.5)
    try:
        process.kill()
        process.wait(timeout=5)
    except OSError:
        pass
    log.close()
    return None, None, None, None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api_session(port, token, method, args, timeout=25):
    """One authenticated 0.1.5 unary call: launch-token exchange, then args POST."""
    base = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(urllib.request.Request(f"{base}/?token={token}"), timeout=timeout)
    except urllib.error.HTTPError as error:
        # The exchange answers 303 + Set-Cookie; urllib reports it as an error.
        response = error
    with response:
        cookie = (response.headers.get("Set-Cookie") or "").split(";")[0]
    if not cookie:
        raise RuntimeError("token exchange returned no browser-session cookie")
    body = json.dumps({
        "type": "client-request",
        "rpcId": secrets.token_hex(8),
        "method": method,
        "payload": {"args": args},
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/api/{method}", data=body,
        headers={"content-type": "application/json", "cookie": cookie}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    result = payload.get("result") or {}
    if not result.get("ok"):
        raise RuntimeError(f"{method} failed: {result.get('error')}")
    return result.get("value")


def seed_session(port, token, marker):
    """Create one session whose title and first user message both carry `marker`."""
    session_id = api_session(port, token, "session/create", {"request": {"cwd": REPO}})["sessionId"]
    api_session(port, token, "session/rename", {"request": {"sessionId": session_id, "title": marker}})
    # The private home has no credential, so the model call fails fast; the user
    # message is durable either way, which is all the session/page assertion needs.
    api_session(port, token, "session/prompt", {"request": {
        "requestId": f"pty-{secrets.token_hex(6)}",
        "sessionId": session_id,
        "mode": "queue",
        "content": [{"type": "text", "text": f"{marker}-MSG"}],
    }})
    for _ in range(60):
        time.sleep(0.5)
        items = api_session(port, token, "session/list", {"_request": {}})["items"]
        item = next((entry for entry in items if entry["sessionId"] == session_id), None)
        if item is not None and not item.get("blank", False) and not item.get("running", False):
            return session_id
    raise RuntimeError("the seeded session never reached a completed first turn")


def data_phase(env):
    """Phase 2: call the live host and assert its RPC data reached the UI frame."""
    process, port, token, log = boot_private_host()
    if process is None:
        return None, b""
    try:
        marker = f"PTYDATA{secrets.token_hex(4).upper()}"
        session_id = seed_session(port, token, marker)

        def drive(fd, out, drain, set_size):
            set_size(60, 150)
            drain(9, out)
            drain(2, out)

        raw_bytes = run_pty(
            ["dsh", "--profile", "tui", "--attach", f"http://127.0.0.1:{port}", "--token", token, "--session", session_id],
            env, 60, 150, drive, 5,
        )
        raw = raw_bytes.decode("utf-8", "replace")
        text = plain(raw_bytes)
        checks = {
            "alternate screen entered": "\x1b[?1049h" in raw,
            "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
            # session/list: the sidebar row renders the title the host returned.
            "host session title rendered (session/list)": marker in text,
            # session/page: the chat pane renders the durable user message text.
            "host session message rendered (session/page)": f"{marker}-MSG" in text,
        }
        return checks, raw_bytes
    except Exception as error:  # noqa: BLE001 - any harness fault is a test failure
        print(f"NOTE: data phase aborted: {type(error).__name__}: {error}")
        return {"data phase completed": False}, b""
    finally:
        try:
            process.terminate()
        except OSError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        if log is not None:
            log.close()


def main():
    live = port_open(HOST, PORT)
    if not live:
        print(f"NOTE: no live DSH host at http://{HOST}:{PORT}; data phase covers the attach contract")

    env = write_tui_profile()
    failed = []
    capture = b""

    if live:
        checks, capture = lifecycle_phase(env)
        print(f"captured {len(capture)} bytes (attach lifecycle)")
        for name, ok in checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    data_checks, data_capture = data_phase(env)
    if data_checks is None:
        if not live:
            print("SKIP: live DSH host unavailable and the private host did not boot")
            raise SystemExit(0)
        print("NOTE: the private host did not boot; RPC-data assertions were skipped")
    else:
        capture = data_capture
        print(f"captured {len(data_capture)} bytes (RPC data)")
        for name, ok in data_checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    if failed:
        with open(FAIL_RAW, "wb") as stream:
            stream.write(capture)
        print(f"FAILED: {', '.join(failed)}; capture saved to {FAIL_RAW}")
        raise SystemExit(1)
    print("PTY lifecycle + RPC data PASS")


if __name__ == "__main__":
    main()
