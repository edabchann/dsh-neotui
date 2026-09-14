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
# Phase 3 (approval push): same private host, but its model route points at a
#   local stub that requests a sandbox escalation. The Host therefore opens an
#   approval waterfall, which can reach the TUI ONLY over the 0.1.5 Remote mux
#   ($events). The phase asserts the approval popup renders (push works) and that
#
# Phase 5 (Host-sourced file access): the TUI runs inside a mount namespace
#   where the session workspace path is bind-mounted onto a decoy directory
#   (same names, different content, none of the Host-only entries). Completion,
#   the file picker and the preview pane must still resolve the HOST files.
#   pressing y makes the Host record the decision and run the tool ($events/result).
import os, pty, time, signal, fcntl, termios, struct, json, socket, select, re, secrets, shutil
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


def boot_private_host(timeout=75, extra_env=None, log_name="web.log"):
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
    log_path = os.path.join(HOSTHOME, log_name)
    log = open(log_path, "w", encoding="utf-8")
    env = dict(os.environ)
    env["DSH_HOME"] = HOSTHOME
    env.update(extra_env or {})
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


# ---- phase 3: a real Host approval must reach the TUI ----------------------

"""
The private web host has no model credential, so phase 3 points the
`deepseek-official` route at a local OpenAI-compatible stub (DEEPSEEK_BASE_URL /
DEEPSEEK_API_KEY). The stub asks for one `bash` call that escalates the sandbox
to `danger-full-access` — strictly wider than the session's `workspace-write`
preset, which is exactly what makes the Host open an `approval/request`
waterfall. That waterfall only reaches the TUI over the 0.1.5 Remote mux
(`$events`), so a rendered approval popup proves the live push channel works;
pressing `y` (允许一次) then proves the TUI's `$events/result` answer is applied
by the Host (the session log gains approval/decided + the tool result).
"""

STUB_TOOL_ARGS = {
    "command": "echo stub-approved",
    "description": "Prove the approval push",
    "sandbox_permissions": "danger-full-access",
    "justification": "PTY acceptance probe needs a wider sandbox",
}


def start_stub_llm(stream_deltas=None, stream_delay=1.0, tool_name="bash", tool_args=None):
    """Serve a deterministic streaming chat/completions stub; return (server, port).

    With `stream_deltas` (a list of strings) the stub streams exactly those
    content deltas `stream_delay` seconds apart — the slow stream phase 4 needs
    to prove text is rendered BEFORE the turn commits.
    """
    import http.server
    import threading

    def chunks(payload):
        model = payload.get("model") or "stub-model"
        call_args = STUB_TOOL_ARGS if tool_args is None else tool_args
        if stream_deltas is not None:
            out = [{"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}]
            for part in stream_deltas:
                out.append({"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}]})
            out.append({"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            return out
        saw_tool_result = any(message.get("role") == "tool" for message in payload.get("messages", []))
        if saw_tool_result:
            return [
                {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "approved-and-ran"}, "finish_reason": None}]},
                {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
        return [
            {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_stub_1", "type": "function", "function": {"name": tool_name, "arguments": json.dumps(call_args)}}]}, "finish_reason": None}]},
            {"id": "stub", "object": "chat.completion.chunk", "created": 0, "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        ]

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *args):  # keep the test output clean
            pass

        def _json(self, value):
            body = json.dumps(value).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._json({"object": "list", "data": [{"id": "stub-model", "object": "model"}]})

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                payload = {}
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            for chunk in chunks(payload):
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()
                if stream_deltas is not None:
                    time.sleep(stream_delay)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    import threading
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def approval_decision(port, token, session_id):
    """Read back the durable approval decision and tool result for the session."""
    items = api_session(port, token, "session/list", {"_request": {}})["items"]
    item = next((entry for entry in items if entry["sessionId"] == session_id), None)
    page = api_session(port, token, "session/page", {"request": {
        "address": {"kind": "session", "sessionId": session_id},
        "throughSeq": (item or {}).get("projections", {}).get("asOfSeq", 0),
        "maxMessages": 60,
    }})
    records = [record.get("event", {}) for record in (page or {}).get("records", [])]
    decided = [event for event in records if event.get("type") == "approval/decided"]
    results = [event for event in records if event.get("type") == "tool/result"]
    return {
        "asked": any(event.get("type") == "approval/asked" for event in records),
        "outcomes": [event.get("data", {}).get("outcome") for event in decided],
        "toolResult": json.dumps([event.get("data") for event in results])[:400],
        "ran": "stub-approved" in json.dumps([event.get("data") for event in results]),
    }


def approval_phase(env):
    """Phase 3: a real approval frame must reach the TUI and its answer must land."""
    server, stub_port = start_stub_llm()
    process, port, token, log = boot_private_host(
        extra_env={"DEEPSEEK_BASE_URL": f"http://127.0.0.1:{stub_port}", "DEEPSEEK_API_KEY": "stub-key"},
        log_name="web-approval.log",
    )
    if process is None:
        server.shutdown()
        return None, b""
    import threading

    try:
        session_id = api_session(port, token, "session/create", {"request": {"cwd": REPO}})["sessionId"]
        api_session(port, token, "session/rename", {"request": {"sessionId": session_id, "title": "PTYAPPROVE"}})

        def fire_prompt():
            # Attach first, then prompt: the approval is delivered live over the
            # mux rather than re-delivered from the Host's pending set.
            time.sleep(9)
            try:
                api_session(port, token, "session/prompt", {"request": {
                    "requestId": f"pty-approve-{secrets.token_hex(6)}",
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [{"type": "text", "text": "run the probe tool"}],
                }})
            except Exception as error:  # noqa: BLE001 - reported through the checks
                print(f"NOTE: approval prompt failed: {type(error).__name__}: {error}")

        threading.Thread(target=fire_prompt, daemon=True).start()
        seen = {"popup": False}

        def drive(fd, out, drain, set_size):
            set_size(60, 150)
            drain(6, out)
            deadline = time.time() + 30
            while time.time() < deadline:
                drain(1, out)
                if "工具需要授权" in plain(b"".join(out)):
                    seen["popup"] = True
                    break
            # Answer 允许一次. The PTY is not a CSI-u terminal (nothing here
            # replies to the kitty query), so a bare "y" arrives as a text run;
            # send the same key the parser turns into {type:"key",name:"char",
            # key:"y"} — the event ApprovalPopup.onKey handles.
            os.write(fd, b"\x1b[121u")
            drain(6, out)

        raw_bytes = run_pty(
            ["dsh", "--profile", "tui", "--attach", f"http://127.0.0.1:{port}", "--token", token, "--session", session_id],
            env, 60, 150, drive, 5,
        )
        raw = raw_bytes.decode("utf-8", "replace")
        text = plain(raw_bytes)
        decision = {}
        for _ in range(20):
            decision = approval_decision(port, token, session_id)
            if decision["outcomes"] or decision["ran"]:
                break
            time.sleep(1)
        checks = {
            "alternate screen entered": "\x1b[?1049h" in raw,
            "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
            # $events: the Host approval/request waterfall reached views.js.
            "approval popup rendered (mux approval/requested)": seen["popup"] and "工具需要授权" in text,
            "approval popup offers the decision": "允许一次" in text,
            "no live-stream fallback toast": "实时事件流不可用" not in text,
            # $events/result: the TUI's answer is what the Host applied.
            "host asked for approval": decision.get("asked", False),
            "host recorded the TUI outcome": "allowed-once" in decision.get("outcomes", []),
            "approved tool actually ran": decision.get("ran", False),
        }
        return checks, raw_bytes
    except Exception as error:  # noqa: BLE001 - any harness fault is a test failure
        print(f"NOTE: approval phase aborted: {type(error).__name__}: {error}")
        return {"approval phase completed": False}, b""
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
        server.shutdown()
        server.server_close()


# ---- phase 4: live assistant deltas must reach the rendered frame ----------

"""
dsh 0.1.5 persists NO `assistant/chunk` event: during a turn the durable log only
gains the settlement event (`assistant/message`) after the model stream ends, so
the tail-poll can render an answer only once the turn is already over. Text that
appears in the frame WHILE the stub is still streaming therefore proves the
`session/follow` Remote stream (mode:"stream", assistantStream:true) drives the
transcript. Phase 4 asserts exactly that timeline:

  * the stub streams a unique head sentinel, filler pieces, then a unique tail
    sentinel, ~1.2s apart (a ~10s window, longer than the attach/settle time);
  * the TUI is attached BEFORE the prompt, so the deltas arrive live;
  * the head sentinel must be on screen while the tail sentinel is still absent,
    and the tail must follow >= 2s later. A poll-only client could paint the
    whole answer at commit time and nothing before it, so two separated moments
    cannot come from the poll.

The sentinels exist because the renderer is a cell diff: a delta's characters
are written contiguously, but different rows/updates interleave in the raw byte
stream, so a long contiguous marker would not survive a naive substring search.
"""

HEAD_SENTINEL = "ZQXJKV"
TAIL_SENTINEL = "WMPZQK"
STREAM_DELAY = 1.2


def stream_phase(env):
    """Phase 4: assistant deltas must render before the turn commits."""
    filler = secrets.token_hex(6).upper()
    # Head sentinel first, tail sentinel last: the streaming window (~10s) stays
    # comfortably longer than the attach+settle time, so the head is always
    # observed well before the tail.
    deltas = [HEAD_SENTINEL, *[filler[index:index + 2] for index in range(0, len(filler), 2)], TAIL_SENTINEL]
    server, stub_port = start_stub_llm(stream_deltas=deltas, stream_delay=STREAM_DELAY)
    process, port, token, log = boot_private_host(
        extra_env={"DEEPSEEK_BASE_URL": f"http://127.0.0.1:{stub_port}", "DEEPSEEK_API_KEY": "stub-key"},
        log_name="web-stream.log",
    )
    if process is None:
        server.shutdown()
        return None, b""
    import threading

    try:
        session_id = api_session(port, token, "session/create", {"request": {"cwd": REPO}})["sessionId"]
        api_session(port, token, "session/rename", {"request": {"sessionId": session_id, "title": "PTYSTREAM"}})

        def fire_prompt():
            # Attach first, then prompt: the deltas must arrive live over the
            # follow stream instead of being re-read from the durable log.
            time.sleep(9)
            try:
                api_session(port, token, "session/prompt", {"request": {
                    "requestId": f"pty-stream-{secrets.token_hex(6)}",
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [{"type": "text", "text": "stream the marker"}],
                }})
            except Exception as error:  # noqa: BLE001 - reported through the checks
                print(f"NOTE: stream prompt failed: {type(error).__name__}: {error}")

        threading.Thread(target=fire_prompt, daemon=True).start()
        seen = {"head_at": None, "head_had_tail": None, "tail_at": None}

        def drive(fd, out, drain, set_size):
            set_size(60, 150)
            drain(6, out)
            deadline = time.time() + 40
            while time.time() < deadline:
                drain(0.2, out)
                text = plain(b"".join(out))
                if seen["head_at"] is None and HEAD_SENTINEL in text:
                    seen["head_at"] = time.time()
                    seen["head_had_tail"] = TAIL_SENTINEL in text
                if seen["tail_at"] is None and TAIL_SENTINEL in text:
                    seen["tail_at"] = time.time()
                    if seen["head_at"] is not None:
                        break
            drain(2, out)

        raw_bytes = run_pty(
            ["dsh", "--profile", "tui", "--attach", f"http://127.0.0.1:{port}", "--token", token, "--session", session_id],
            env, 60, 150, drive, 5,
        )
        raw = raw_bytes.decode("utf-8", "replace")
        text = plain(raw_bytes)
        span = None if (seen["head_at"] is None or seen["tail_at"] is None) else seen["tail_at"] - seen["head_at"]
        if span is not None:
            print(f"NOTE: head sentinel rendered {span:.2f}s before the tail sentinel")
        checks = {
            "alternate screen entered": "\x1b[?1049h" in raw,
            "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
            "no live-stream fallback toast": "实时事件流不可用" not in text and "会话实时流不可用" not in text,
            # The head delta was on screen while the tail delta did not exist yet:
            # only a live stream can paint a partial answer.
            "streamed delta rendered mid-turn (follow stream)": seen["head_at"] is not None and seen["head_had_tail"] is False,
            "later deltas completed the answer in-frame": seen["tail_at"] is not None,
            "deltas rendered over time, not in one poll": span is not None and span >= 2.0,
        }
        return checks, raw_bytes
    except Exception as error:  # noqa: BLE001 - any harness fault is a test failure
        print(f"NOTE: stream phase aborted: {type(error).__name__}: {error}")
        return {"stream phase completed": False}, b""
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
        server.shutdown()
        server.server_close()


# ---- phase 5: file access is Host-sourced, not terminal-local --------------

"""
The Host owns the session workspace. This phase makes the two views DISAGREE:
the TUI process is attached inside a bubblewrap mount namespace where the
session's workspace path is bind-mounted onto a decoy directory holding the same
file NAME with different CONTENT (and none of the Host-only entries). That is
precisely a remote deployment — the terminal's disk is not the Host's disk.

The TUI must then render:
  * an @-mention candidate that exists at NO local path (`sub/host-only-file.txt`);
  * a Ctrl+O picker listing the Host-only entries (`attach-me.txt`);
  * the Host file's CONTENT in the preview pane, never the decoy's text.

Without the 0.1.5 `workspaceFiles/*` / `fileReferences/list` surface every one
of those reads the decoy, which is what this phase fails on.
"""

HOST_MARKER = "HOST-SIDE-MARKER-VALUE 7f3a91"
DECOY_MARKER = "LOCAL-DECOY-MARKER-VALUE deadbeef"


def remote_correctness_phase(env):
    """Phase 5: file preview/completion must resolve through the Host."""
    if shutil.which("bwrap") is None:
        print("NOTE: bubblewrap is unavailable; the remote-correctness phase was skipped")
        return None, b""
    real_ws = os.path.join(HOSTHOME, "remote-ws")
    decoy_ws = os.path.join(HOSTHOME, "remote-decoy")
    for path in (real_ws, decoy_ws):
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(path, exist_ok=True)
    os.makedirs(os.path.join(real_ws, "sub"), exist_ok=True)
    with open(os.path.join(real_ws, "host-only-marker.txt"), "w", encoding="utf-8") as stream:
        stream.write(f"{HOST_MARKER}\nsecond host line\n")
    with open(os.path.join(real_ws, "sub", "host-only-file.txt"), "w", encoding="utf-8") as stream:
        stream.write("host-only nested content alpha\n")
    with open(os.path.join(real_ws, "attach-me.txt"), "w", encoding="utf-8") as stream:
        stream.write("attachment body\n")
    # The decoy: same NAME, different CONTENT, none of the Host-only entries.
    with open(os.path.join(decoy_ws, "host-only-marker.txt"), "w", encoding="utf-8") as stream:
        stream.write(f"{DECOY_MARKER}\nlocal decoy line\n")

    process, port, token, log = boot_private_host(log_name="web-remotefiles.log")
    if process is None:
        return None, b""
    try:
        session_id = api_session(port, token, "session/create", {"request": {"cwd": real_ws}})["sessionId"]
        seen = {"mention": None, "picker": None, "preview": None}

        def drive(fd, out, drain, set_size):
            def frame():
                return plain(b"".join(out))

            set_size(60, 150)
            drain(10, out)
            # 1. @-mention completion: INSERT owns the input and the file picker.
            os.write(fd, b"i")
            drain(1, out)
            os.write(fd, b"@sub/")
            drain(0.5, out)
            os.write(fd, b"\t")
            drain(2.5, out)
            seen["mention"] = frame()
            # 2. Ctrl+O (INSERT) opens the Host-backed workspace picker.
            os.write(fd, b"\x0f")
            drain(4, out)
            seen["picker"] = frame()
            # 3. Walk the listing until the Host marker content is previewed:
            #    the row index depends on the Host's own entry set.
            seen["preview"] = frame()
            for _ in range(12):
                if HOST_MARKER in seen["preview"]:
                    break
                os.write(fd, b"\x1b[B")
                drain(0.5, out)
                seen["preview"] = frame()
            drain(2, out)
            seen["preview"] = frame()

        argv = [
            "bwrap", "--dev-bind", "/", "/", "--bind", decoy_ws, real_ws,
            "dsh", "--profile", "tui", "--attach", f"http://127.0.0.1:{port}",
            "--token", token, "--session", session_id,
        ]
        raw_bytes = run_pty(argv, env, 60, 150, drive, 5)
        text = plain(raw_bytes)
        raw = raw_bytes.decode("utf-8", "replace")
        checks = {
            "@-completion offers a Host-only path (fileReferences/list)": "host-only-file.txt" in (seen["mention"] or text),
            "picker lists Host-only entries (workspaceFiles/list)": "attach-me.txt" in (seen["picker"] or text),
            "preview shows the HOST content (workspaceFiles/read)": HOST_MARKER in (seen["preview"] or text),
            "preview never shows the decoy content": DECOY_MARKER not in (seen["preview"] or text),
            "alternate screen entered": "\x1b[?1049h" in raw,
            "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
        }
        return checks, raw_bytes
    except Exception as error:  # noqa: BLE001 - any harness fault is a test failure
        print(f"NOTE: remote-correctness phase aborted: {type(error).__name__}: {error}")
        return {"remote-correctness phase completed": False}, b""
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


# ---- phase 6: the 文件/改动 tab renders the Host's change feed ------------

"""
`workspaceFiles/changes` relays instrumented filesystem operations only, so the
frame this phase asserts cannot be faked from the test process: the private host
is booted with a stub model that requests ONE `write` tool call, which the Host
runs through its composed filesystem inside the session workspace. The TUI is
attached and switched to the 文件/改动 tab BEFORE the prompt, because the feed
reports observations from the moment its generation is opened — the row must
appear live, from the Host stream.
"""


def changes_phase(env):
    """Phase 6: a Host-instrumented write becomes a row in 文件/改动."""
    workspace = os.path.join(HOSTHOME, "changes-ws")
    shutil.rmtree(workspace, ignore_errors=True)
    os.makedirs(workspace, exist_ok=True)
    target = os.path.join(workspace, "written-by-agent.txt")
    server, stub_port = start_stub_llm(tool_name="write", tool_args={"file_path": target, "content": "written by the host write tool\n"})
    process, port, token, log = boot_private_host(
        extra_env={"DEEPSEEK_BASE_URL": f"http://127.0.0.1:{stub_port}", "DEEPSEEK_API_KEY": "stub-key"},
        log_name="web-changes.log",
    )
    if process is None:
        server.shutdown()
        return None, b""
    import threading

    def fire_prompt():
        time.sleep(9)   # attach + tab switch first: the feed must open before the write
        try:
            api_session(port, token, "session/prompt", {"request": {
                "requestId": f"pty-changes-{secrets.token_hex(6)}",
                "sessionId": session_id,
                "mode": "queue",
                "content": [{"type": "text", "text": "write the file"}],
            }})
        except Exception as error:  # noqa: BLE001 - reported through the checks
            print(f"NOTE: changes prompt failed: {type(error).__name__}: {error}")

    try:
        session_id = api_session(port, token, "session/create", {"request": {"cwd": workspace}})["sessionId"]

        def drive(fd, out, drain, set_size):
            set_size(60, 150)
            drain(9, out)
            # Shift+Tab x4: 对话 → 轨迹 → 子代理 → 后台任务 → 文件/改动
            for _ in range(4):
                os.write(fd, b"\x1b[Z")
                drain(0.6, out)
            drain(1, out)
            threading.Thread(target=fire_prompt, daemon=True).start()
            deadline = time.time() + 45
            while time.time() < deadline:
                drain(0.5, out)
                if "written-by-agent.txt" in plain(b"".join(out)):
                    break
            drain(2, out)

        raw_bytes = run_pty(
            ["dsh", "--profile", "tui", "--attach", f"http://127.0.0.1:{port}", "--token", token, "--session", session_id],
            env, 60, 150, drive, 5,
        )
        text = plain(raw_bytes)
        raw = raw_bytes.decode("utf-8", "replace")
        checks = {
            "文件/改动 tab is on the strip and reachable": "文件/改动" in text,
            "Host change frame rendered as a row (workspaceFiles/changes)": "written-by-agent.txt" in text,
            "the Host really wrote the file": os.path.exists(target),
            "alternate screen entered": "\x1b[?1049h" in raw,
            "no runtime fatal": not any(term in raw for term in ("TypeError", "RangeError", "Cannot find package", "plugin(s) failed to load", "fatal:")),
        }
        return checks, raw_bytes
    except Exception as error:  # noqa: BLE001 - any harness fault is a test failure
        print(f"NOTE: changes phase aborted: {type(error).__name__}: {error}")
        return {"changes phase completed": False}, b""
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
        server.shutdown()
        server.server_close()


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

    approval_checks, approval_capture = approval_phase(env)
    if approval_checks is None:
        print("NOTE: the private host did not boot; approval-push assertions were skipped")
    else:
        capture = approval_capture
        print(f"captured {len(approval_capture)} bytes (approval push)")
        for name, ok in approval_checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    stream_checks, stream_capture = stream_phase(env)
    if stream_checks is None:
        print("NOTE: the private host did not boot; live-stream assertions were skipped")
    else:
        capture = stream_capture
        print(f"captured {len(stream_capture)} bytes (live stream)")
        for name, ok in stream_checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    remote_checks, remote_capture = remote_correctness_phase(env)
    if remote_checks is None:
        print("NOTE: the private host did not boot; remote-correctness assertions were skipped")
    else:
        capture = remote_capture
        print(f"captured {len(remote_capture)} bytes (remote file access)")
        for name, ok in remote_checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    changes_checks, changes_capture = changes_phase(env)
    if changes_checks is None:
        print("NOTE: the private host did not boot; changes-tab assertions were skipped")
    else:
        capture = changes_capture
        print(f"captured {len(changes_capture)} bytes (文件/改动 tab)")
        for name, ok in changes_checks.items():
            print(f"{'PASS' if ok else 'FAIL'}: {name}")
            if not ok:
                failed.append(name)

    if failed:
        with open(FAIL_RAW, "wb") as stream:
            stream.write(capture)
        print(f"FAILED: {', '.join(failed)}; capture saved to {FAIL_RAW}")
        raise SystemExit(1)
    print("PTY lifecycle + RPC data + approval push + live stream + remote file access + changes tab PASS")


if __name__ == "__main__":
    main()
