#!/usr/bin/env python3
# Full-pipeline PTY test: real ANSI diff + real SGR mouse bytes -> term.js -> App.
import os, pty, time, signal, fcntl, termios, struct, re, select, sys, unicodedata

def cw(ch):
    if ch == "": return 0
    if unicodedata.combining(ch): return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"): return 2
    return 1

ROWS, COLS = 44, 118
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/home/edabchann/dsh/tui")
    env = dict(os.environ, TERM="xterm-256color", DSH_TUI_NO_KITTY="1", DSH_TUI_DEBUG_CLICK="1", DSH_HOME="/tmp/dsh-tui-dbghome")
    os.execvpe("node", ["node", "bin/dsh-tui.js", "--attach", "http://127.0.0.1:3080"], env)

def set_size(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

class Grid:
    def __init__(s, rows, cols):
        s.rows, s.cols = rows, cols
        s.g = [[" "] * cols for _ in range(rows)]
        s.cy = s.cx = 0
    def feed(s, data):
        text = data.decode("utf-8", "replace")
        i = 0
        while i < len(text):
            c = text[i]
            if c == "\x1b":
                m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", text[i:])
                if m:
                    p, f = m.group(1), m.group(2)
                    i += m.end()
                    if f in "Hf":
                        ps = p.split(";")
                        try:
                            s.cy = (int(ps[0]) if ps[0] else 1) - 1
                            s.cx = (int(ps[1]) if len(ps) > 1 and ps[1] else 1) - 1
                        except ValueError: pass
                    elif f == "J" and p in ("2", "3"):
                        s.g = [[" "] * s.cols for _ in range(s.rows)]
                    elif f == "K":
                        for x in range(s.cx, s.cols): s.g[s.cy][x] = " "
                    continue
                m = re.match(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", text[i:])
                if m:
                    i += m.end(); continue
                i += 1; continue
            if c == "\r": s.cx = 0
            elif c == "\n": s.cy = min(s.rows - 1, s.cy + 1)
            elif c >= " ":
                w = cw(c)
                s.g[s.cy][s.cx] = c
                if w == 2 and s.cx + 1 < s.cols: s.g[s.cy][s.cx + 1] = ""
                s.cx = min(s.cols - 1, s.cx + w)
            i += 1
    def row(s, y):
        return "".join(s.g[y]).rstrip()

out = []
grid = Grid(ROWS, COLS)
def drain(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                b = os.read(fd, 65536)
                out.append(b); grid.feed(b)
            except OSError:
                return

set_size(ROWS, COLS)
drain(10)
def find_header():
    for y in range(ROWS):
        r = grid.row(y)
        i = r.find("[b ")
        if i >= 30 and ("折" in r or "展" in r):
            return y, r[i:i+20]
    return None, None
# open the running session: click the sidebar row containing the target title
def click_sidebar(target):
    for y in range(ROWS):
        r = grid.row(y)
        if "评估TUI" in r and y >= 2:
            x = r.find("评估TUI") + 1
            os.write(fd, f"\x1b[<0;{x + 1};{y + 1}M".encode())
            os.write(fd, f"\x1b[<0;{x + 1};{y + 1}m".encode())
            return y
    return -1
click_sidebar("评估TUI")
drain(8)
for y in range(ROWS):
    if grid.row(y).strip():
        print("DBG row", y, repr(grid.row(y)[:80]))
hdr_y, hdr_text = find_header()
print("click target: row", hdr_y, repr(hdr_text))
if hdr_y is None:
    print("no tool header found"); os.kill(pid, signal.SIGKILL); sys.exit(0)
# click several positions: the header row and rows ABOVE/BELOW it, measuring
# which block visually sits at the clicked row vs which one toggles
def visible_header_rows():
    rows = []
    for y in range(ROWS):
        r = grid.row(y)
        if "[b " in r and ("折" in r or "展" in r):
            rows.append(y)
    return rows
hdr_rows = visible_header_rows()
print("tool headers at rows:", hdr_rows)
for off in [0, 2, -2]:
    ty = hdr_y + off
    if ty < 0: continue
    os.write(fd, f"\x1b[<0;40;{ty + 1}M".encode())
    drain(0.3)
    os.write(fd, f"\x1b[<0;40;{ty + 1}m".encode())
    drain(1.2)
    try:
        log = open("/tmp/dsh-tui-dbghome/tui-click-debug.log").read().strip().split("\n")
        print(f"clicked row {ty}:")
        for line in log[-3:]:
            print("   ", line[11:140])
    except Exception as e:
        print(f"clicked row {ty}: log unreadable {e}")
# also: click the trailer of a collapsed TEXT block and measure the expansion
def find_trailer():
    for y in range(ROWS):
        r = grid.row(y)
        if "…共" in r and "点击展开" in r:
            return y, r
    return None, None
try_y, try_text = find_trailer()
if try_y is not None:
    print("trailer at row", try_y, repr(try_text[:50]))
    # find the next block header BELOW the trailer before clicking
    below_before = []
    for y in range(try_y, ROWS):
        r = grid.row(y)
        m = re.search(r"▸\s+(step )?\S", r)
        if m and y > try_y:
            below_before.append((y, r[:40]))
            if len(below_before) >= 2: break
    os.write(fd, f"\x1b[<0;40;{try_y + 1}M".encode())
    drain(0.4)
    os.write(fd, f"\x1b[<0;40;{try_y + 1}m".encode())
    drain(1.5)
    below_after = []
    for y in range(try_y, ROWS):
        r = grid.row(y)
        if re.search(r"▸\s+(step )?\S", r) and y > try_y:
            below_after.append((y, r[:40]))
            if len(below_after) >= 2: break
    print("content below the trailer: before", below_before, "after", below_after)
os.kill(pid, signal.SIGKILL)
