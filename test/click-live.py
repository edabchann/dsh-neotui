#!/usr/bin/env python3
# Live PTY verification: boot a fresh TUI instance against the attached host,
# drive mouse clicks via SGR sequences, and snapshot the screen grid to assert
# the new click behaviors (right-click expand/collapse, chat<->trajectory
# jump, trajectory 详细/简略, user-message prefix).
import os, pty, time, signal, fcntl, termios, struct, select, re, sys

ROWS, COLS = 44, 118
CAP = "/home/edabchann/dsh/tui/test/click-live.raw"

# ---- minimal ANSI grid emulator (enough for screen.js output) ----
class Grid:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.g = [[" "] * cols for _ in range(rows)]
        self.cx = self.cy = 0
    def feed(self, data):
        i = 0
        n = len(data)
        while i < n:
            c = chr(data[i])
            if c == "\x1b":
                if i + 1 < n and data[i + 1] == "[":
                    j = data.find("]", i + 2) if False else None
                    m = re.match(rb"\x1b\[([0-9;?]*)([A-Za-z])", data[i:])
                    if m:
                        params, final = m.group(1).decode(), m.group(2).decode()
                        i += m.end()
                        if final in "Hf":
                            ps = params.split(";")
                            try:
                                r = int(ps[0]) if ps[0] else 1
                                cc = int(ps[1]) if len(ps) > 1 and ps[1] else 1
                                self.cy, self.cx = r - 1, cc - 1
                            except ValueError:
                                pass
                        elif final == "J" and params in ("2", "3"):
                            self.g = [[" "] * self.cols for _ in range(self.rows)]
                        elif final == "K":
                            for x in range(self.cx, self.cols):
                                self.g[self.cy][x] = " "
                        continue
                    m = re.match(rb"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", data[i:])
                    if m:
                        i += m.end()
                        continue
                    i += 1
                    continue
                if i + 1 < n and data[i + 1] == "=":
                    i += 2
                    continue
                if i + 1 < n and data[i + 1] in "()78M>":
                    i += 2
                    continue
                i += 1
                continue
            if c == "\r":
                self.cx = 0
            elif c == "\n":
                self.cy = min(self.rows - 1, self.cy + 1)
            elif c == "\b":
                self.cx = max(0, self.cx - 1)
            elif c == "\t":
                self.cx = min(self.cols - 1, (self.cx // 8 + 1) * 8)
            elif c >= " ":
                self.g[self.cy][self.cx] = c
                self.cx = min(self.cols - 1, self.cx + 1)
            i += 1
    def row(self, y):
        return "".join(self.g[y]).rstrip()
    def lines(self):
        return [self.row(y) for y in range(self.rows)]
    def find(self, needle, x0=0, y0=0, x1=None, y1=None):
        x1 = x1 if x1 is not None else self.cols
        y1 = y1 if y1 is not None else self.rows
        for y in range(y0, y1):
            r = self.row(y)
            idx = r.find(needle)
            if idx >= x0 and idx < x1:
                return (idx, y)
        return None

env = dict(os.environ)
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/home/edabchann/dsh/tui")
    os.execvpe("dsh", ["dsh", "--profile", "dsh-neotui", "--attach", "http://127.0.0.1:3080"], env)

def set_size(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

out = []
def drain(t, quiet=False):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            try:
                data = os.read(fd, 65536)
                out.append(data)
            except OSError:
                return False
    return True

def snapshot(t=0.6):
    drain(t)
    g = Grid(ROWS, COLS)
    g.feed(b"".join(out))
    return g

def click(btn, x, y, button=0):
    b = (button & 3) | ((btn >> 4) & 0x1C)  # keep modifiers field of btn
    os.write(fd, f"\x1b[<{button};{x+1};{y+1}M".encode())
    os.write(fd, f"\x1b[<{button};{x+1};{y+1}m".encode())

def right(x, y):
    click(2, x, y, button=2)

def left(x, y):
    click(0, x, y, button=0)

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if extra else ""))

set_size(ROWS, COLS)
print("booting…")
drain(10)

g = snapshot()
# open the running session from the sidebar
pos = g.find("评估TUI", 0, 0, 30, ROWS)
if not pos:
    pos = g.find("评估TUI", 0, 0)
check("sidebar shows target session", pos is not None)
if pos:
    left(pos[0] + 2, pos[1])
    drain(6)

g = snapshot()
lines = g.lines()
chatlines = [l for l in lines if "[b 折叠]" in l or "[b 展开]" in l or "edabchann >" in l or " > " in l[:30]]
check("user message shows 'name > ' prefix", any("edabchann >" in l for l in lines), repr([l for l in lines if "edabchann >" in l][:2]))
barline = [i for i, l in enumerate(lines) if l.startswith("▎")]
check("no bare '▎' first-line marker row", len(barline) == 0, f"found rows {barline[:3]}")

# right-click a tool block header, toggle 展开/折叠
toolpos = g.find("[b 折叠]")
if not toolpos:
    toolpos = g.find("[b 展开]")
check("tool block header visible", toolpos is not None)
if toolpos:
    x, y = toolpos[0] + 1, toolpos[1]
    right(x, y)
    g = snapshot()
    mrow = [i for i, l in enumerate(g.lines()) if "复制消息" in l]
    check("right-click menu appears", len(mrow) > 0)
    if mrow:
        my = mrow[0]
        menu_items = g.row(my)
        check("menu has 转跳轨迹", "转跳轨迹" in menu_items)
        # items: 复制消息(0) 展开 / 折叠(1) 转跳轨迹(2) …
        toggle_y = my + 1
        left(8, toggle_y)
        g = snapshot()
        check("block collapsed after menu toggle", g.find("[b 展开]") is not None and g.find("[b 折叠]") is None)
        # toggle back
        right(x, y)
        g = snapshot()
        mrow = [i for i, l in enumerate(g.lines()) if "复制消息" in l]
        left(8, mrow[0] + 1)
        g = snapshot()
        check("block re-expanded after second toggle", g.find("[b 折叠]") is not None)

# chat -> trajectory jump via right-click menu
if toolpos:
    x, y = toolpos[0] + 1, toolpos[1]
    right(x, y)
    g = snapshot()
    mrow = [i for i, l in enumerate(g.lines()) if "复制消息" in l]
    if mrow:
        # 转跳轨迹 is item index 2 -> row my+3
        left(8, mrow[0] + 3)
        drain(5)
        g = snapshot()
        lines = g.lines()
        check("switched to trajectory mode", any("轨迹 — 步骤时间轴" in l for l in lines))
        check("jumped step auto-expanded (▾)", any("▾ step" in l for l in lines), repr([l for l in lines if "▾ step" in l][:1]))
        check("expanded step shows inline events", any(re.search(r"#\s+\d+", l) for l in lines))

        # left-click a step row: must do nothing
        steppos = g.find("▾ step")
        before = g.row(steppos[1]) if steppos else ""
        if steppos:
            left(steppos[0] + 2, steppos[1])
            g2 = snapshot()
            after = g2.row(steppos[1])
            check("left click on step changes nothing (no popup)", after == before and "轨迹详情" not in "\n".join(g2.lines()))

        # right-click a step: menu with 展开（详细）/折叠（简略）/转跳对话/查看详情
        if steppos:
            right(steppos[0] + 2, steppos[1])
            g3 = snapshot()
            mrow = [i for i, l in enumerate(g3.lines()) if "折叠（简略）" in l]
            check("step right-click menu shows 折叠（简略）", len(mrow) > 0)
            # toggle to collapsed
            if mrow:
                left(10, mrow[0])
                g4 = snapshot()
                check("step collapsed (▸ back)", g4.find("▸ step") is not None)
                # re-expand via menu
                right(steppos[0] + 2, steppos[1])
                g5 = snapshot()
                mrow2 = [i for i, l in enumerate(g5.lines()) if "展开（详细）" in l]
                if mrow2:
                    left(10, mrow2[0])
                    g6 = snapshot()
                    check("step re-expanded via menu", g6.find("▾ step") is not None)
            # jump back to chat
            right(steppos[0] + 2, steppos[1])
            g7 = snapshot()
            jrow = [i for i, l in enumerate(g7.lines()) if "转跳对话" in l]
            if jrow:
                left(10, jrow[0])
                drain(4)
                g8 = snapshot()
                check("jumped back to chat mode", any("edabchann >" in l or "[b 折叠]" in l or "[b 展开]" in l for l in g8.lines()))

# quit
os.write(fd, b"\x11")
drain(1.5)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
open(CAP, "wb").write(b"".join(out))
print("\nsummary:", sum(1 for _, ok in results if ok), "/", len(results), "passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
