"""OpenDesk 2 - peer-to-peer remote desktop for Windows.

This process is the native backend: it captures the screen, injects input,
reads/writes files and the clipboard, and stores settings. The UI (public/)
runs in an embedded WebView2 window and owns the network side (rendezvous
over MQTT brokers + WebRTC data channel). UI and backend talk over a
token-protected WebSocket bound to 127.0.0.1 only.
"""
import argparse
import asyncio
import base64
import ctypes
import hashlib
import hmac
import io
import json
import logging
import os
import secrets
import socket
import struct
import sys
import threading
import time
from ctypes import wintypes

from aiohttp import web, WSMsgType

VERSION = "2.0.0"

# Per-monitor DPI awareness must be set before anything creates a window, so
# screen capture and mouse coordinates are both in physical pixels.
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import mss  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# ----------------------------------------------------------------------------
# Arguments, paths, logging
# ----------------------------------------------------------------------------
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--profile", default="")      # separate identity/config (testing two desks on one PC)
parser.add_argument("--headless", action="store_true")  # backend only, UI opened in a browser (development)
parser.add_argument("--port", type=int, default=0)
parser.add_argument("--minimized", action="store_true")
ARGS, _ = parser.parse_known_args()

if getattr(sys, "frozen", False):
    BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "public")

_safe_profile = "".join(c for c in ARGS.profile if c.isalnum() or c in "-_")[:32]
CONFIG_DIR = os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"),
    "OpenDesk" + ("-" + _safe_profile if _safe_profile else ""),
)
os.makedirs(CONFIG_DIR, exist_ok=True)
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

_handlers = [logging.FileHandler(os.path.join(CONFIG_DIR, "opendesk.log"), mode="w", encoding="utf-8")]
if sys.stderr is not None:
    _handlers.append(logging.StreamHandler())
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", handlers=_handlers)
log = logging.getLogger("OpenDesk")

TOKEN = secrets.token_urlsafe(24)
WINDOW = None  # pywebview window, when running with the native window

DEFAULT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt",
]
DEFAULT_ICE = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
    {"urls": "stun:stun.cloudflare.com:3478"},
]
QUALITY = {
    "quality": {"q": 88, "maxw": 0, "fps": 30, "sub": 0},
    "balanced": {"q": 68, "maxw": 1920, "fps": 25, "sub": 2},
    "speed": {"q": 42, "maxw": 1366, "fps": 30, "sub": 2},
}
VIEWS = ("fit", "original", "stretch")


# ----------------------------------------------------------------------------
# Settings
# ----------------------------------------------------------------------------
class Config:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {}
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                self.data = json.load(f)
        except Exception:
            self.data = {}
        d = self.data
        if not str(d.get("id", "")).isdigit() or len(str(d.get("id"))) != 9:
            d["id"] = str(secrets.randbelow(900_000_000) + 100_000_000)
        d.setdefault("name", socket.gethostname())
        sec = d.setdefault("security", {})
        sec.setdefault("interactive", "always")
        sec.setdefault("pw_salt", "")
        sec.setdefault("pw_key", "")
        perms = sec.setdefault("perms", {})
        for k in ("control", "clipboard", "files"):
            perms.setdefault(k, True)
        disp = d.setdefault("display", {})
        disp.setdefault("quality", "balanced")
        disp.setdefault("view", "fit")
        disp.setdefault("show_cursor", True)
        net = d.setdefault("network", {})
        net.setdefault("brokers", list(DEFAULT_BROKERS))
        net.setdefault("ice", [dict(x) for x in DEFAULT_ICE])
        d.setdefault("general", {}).setdefault("autostart", False)
        d.setdefault("recents", [])
        self.save()

    def save(self):
        with self.lock:
            tmp = CONFIG_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2)
            os.replace(tmp, CONFIG_PATH)

    def public(self):
        """Settings as shown to the UI: no password material."""
        d = self.data
        sec = d["security"]
        return {
            "version": VERSION,
            "id": d["id"],
            "name": d["name"],
            "config_dir": CONFIG_DIR,
            "security": {
                "interactive": sec["interactive"],
                "has_password": bool(sec["pw_key"]),
                "perms": dict(sec["perms"]),
            },
            "display": dict(d["display"]),
            "network": {"brokers": list(d["network"]["brokers"]), "ice": list(d["network"]["ice"])},
            "general": dict(d["general"]),
            "recents": [
                {"id": r["id"], "name": r.get("name", ""), "alias": r.get("alias", ""),
                 "last": r.get("last", 0), "saved": bool(r.get("key"))}
                for r in d["recents"]
            ],
        }


CFG = Config()


def derive_key(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 150_000).hex()


def make_proof(key_hex, nonce, fps):
    msg = (nonce + "|" + "|".join(sorted(str(f).upper() for f in fps))).encode()
    return hmac.new(bytes.fromhex(key_hex), msg, hashlib.sha256).hexdigest()


def set_autostart(enabled):
    import winreg
    name = "OpenDesk" + ("-" + _safe_profile if _safe_profile else "")
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                         winreg.KEY_SET_VALUE)
    try:
        if enabled:
            if getattr(sys, "frozen", False):
                cmd = f'"{sys.executable}"'
            else:
                cmd = f'"{sys.executable}" "{os.path.abspath(__file__)}"'
            if _safe_profile:
                cmd += f" --profile {_safe_profile}"
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, cmd + " --minimized")
        else:
            try:
                winreg.DeleteValue(key, name)
            except FileNotFoundError:
                pass
    finally:
        winreg.CloseKey(key)


# ----------------------------------------------------------------------------
# Input injection (SendInput)
# ----------------------------------------------------------------------------
ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT

M_MOVE, M_ABS, M_VDESK, M_WHEEL, M_HWHEEL = 0x0001, 0x8000, 0x4000, 0x0800, 0x1000
M_BUTTONS = {0: (0x0002, 0x0004), 2: (0x0008, 0x0010), 1: (0x0020, 0x0040)}  # left, right, middle
K_EXT, K_UP, K_UNICODE = 0x0001, 0x0002, 0x0004

VK = {
    "Backspace": 0x08, "Tab": 0x09, "Enter": 0x0D, "ShiftLeft": 0xA0, "ShiftRight": 0xA1,
    "ControlLeft": 0xA2, "ControlRight": 0xA3, "AltLeft": 0xA4, "AltRight": 0xA5, "Pause": 0x13,
    "CapsLock": 0x14, "Escape": 0x1B, "Space": 0x20, "PageUp": 0x21, "PageDown": 0x22, "End": 0x23,
    "Home": 0x24, "ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28,
    "PrintScreen": 0x2C, "Insert": 0x2D, "Delete": 0x2E, "MetaLeft": 0x5B, "MetaRight": 0x5C,
    "ContextMenu": 0x5D, "NumLock": 0x90, "ScrollLock": 0x91, "Semicolon": 0xBA, "Equal": 0xBB,
    "Comma": 0xBC, "Minus": 0xBD, "Period": 0xBE, "Slash": 0xBF, "Backquote": 0xC0,
    "BracketLeft": 0xDB, "Backslash": 0xDC, "BracketRight": 0xDD, "Quote": 0xDE, "IntlBackslash": 0xE2,
    "NumpadMultiply": 0x6A, "NumpadAdd": 0x6B, "NumpadSubtract": 0x6D, "NumpadDecimal": 0x6E,
    "NumpadDivide": 0x6F, "NumpadEnter": 0x0D,
}
for _i in range(26):
    VK["Key" + chr(65 + _i)] = 0x41 + _i
for _i in range(10):
    VK[f"Digit{_i}"] = 0x30 + _i
    VK[f"Numpad{_i}"] = 0x60 + _i
for _i in range(1, 25):
    VK[f"F{_i}"] = 0x6F + _i
EXTENDED = {"ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Insert", "Delete", "Home", "End", "PageUp",
            "PageDown", "ControlRight", "AltRight", "NumpadEnter", "NumpadDivide", "MetaLeft", "MetaRight",
            "ContextMenu", "PrintScreen", "NumLock"}


def _send(inp):
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def _mouse(flags, dx=0, dy=0, data=0):
    inp = INPUT(type=0)
    inp.u.mi = MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
    _send(inp)


def mouse_move(mon, x, y):
    """Move to a 0..1 position inside monitor `mon` (physical px rect)."""
    x = min(1.0, max(0.0, float(x)))
    y = min(1.0, max(0.0, float(y)))
    vx, vy = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    vw, vh = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)
    px = mon["left"] + x * (mon["width"] - 1)
    py = mon["top"] + y * (mon["height"] - 1)
    nx = int(round((px - vx) * 65535 / max(1, vw - 1)))
    ny = int(round((py - vy) * 65535 / max(1, vh - 1)))
    _mouse(M_MOVE | M_ABS | M_VDESK, nx, ny)


def mouse_button(button, down):
    flags = M_BUTTONS.get(int(button))
    if flags:
        _mouse(flags[0] if down else flags[1])


def mouse_wheel(dx, dy):
    if dy:
        _mouse(M_WHEEL, data=int(max(-1200, min(1200, -float(dy) * 1.2))))
    if dx:
        _mouse(M_HWHEEL, data=int(max(-1200, min(1200, float(dx) * 1.2))))


def key_event(code, key, down):
    inp = INPUT(type=1)
    vk = VK.get(code)
    if vk:
        flags = (K_EXT if code in EXTENDED else 0) | (0 if down else K_UP)
        inp.u.ki = KEYBDINPUT(vk, user32.MapVirtualKeyW(vk, 0), flags, 0, 0)
    elif key and len(key) == 1:
        inp.u.ki = KEYBDINPUT(0, ord(key), K_UNICODE | (0 if down else K_UP), 0, 0)
    else:
        return
    _send(inp)


# ----------------------------------------------------------------------------
# Clipboard (text)
# ----------------------------------------------------------------------------
def clip_get():
    import win32clipboard as wc
    for _ in range(3):
        try:
            wc.OpenClipboard()
            try:
                if wc.IsClipboardFormatAvailable(wc.CF_UNICODETEXT):
                    return wc.GetClipboardData(wc.CF_UNICODETEXT)
                return None
            finally:
                wc.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return None


CLIP_ROOT = os.path.join(os.environ.get("TEMP") or CONFIG_DIR, "OpenDesk-clipboard" + ("-" + _safe_profile if _safe_profile else ""))
CLIP_MAX_FILES = 2000
CLIP_MAX_BYTES = 2 * 1024 ** 3


def clip_read():
    """Current clipboard as ("files", [paths]) or ("text", str), else None."""
    import win32clipboard as wc
    for _ in range(3):
        try:
            wc.OpenClipboard()
            try:
                if wc.IsClipboardFormatAvailable(wc.CF_HDROP):
                    return "files", list(wc.GetClipboardData(wc.CF_HDROP))
                if wc.IsClipboardFormatAvailable(wc.CF_UNICODETEXT):
                    return "text", wc.GetClipboardData(wc.CF_UNICODETEXT)
                return None
            finally:
                wc.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return None


def clip_expand(paths):
    """Copied files/folders -> flat list of {p: full path, rel: path below the copy root, s: size}."""
    items, total = [], 0

    def add(p, rel):
        nonlocal total
        size = os.path.getsize(p)
        total += size
        items.append({"p": p, "rel": rel.replace("\\", "/"), "s": size})
        if len(items) > CLIP_MAX_FILES or total > CLIP_MAX_BYTES:
            raise ValueError("The copied files are too many or too large for copy and paste (limit 2,000 files / 2 GB). "
                             "Use the Files window instead.")
    for p in paths:
        if "OpenDesk-clipboard" in os.path.abspath(p):
            return []  # files we received ourselves: do not send them back
        if os.path.isfile(p):
            add(p, os.path.basename(p))
        elif os.path.isdir(p):
            base = os.path.dirname(os.path.abspath(p))
            for root, _dirs, files in os.walk(p):
                for name in files:
                    full = os.path.join(root, name)
                    try:
                        add(full, os.path.relpath(full, base))
                    except OSError:
                        continue
    return items


def clip_new_dir():
    """Fresh folder for one batch of pasted files; older batches are discarded."""
    import shutil
    shutil.rmtree(CLIP_ROOT, ignore_errors=True)
    d = os.path.join(CLIP_ROOT, secrets.token_hex(4))
    os.makedirs(d, exist_ok=True)
    return d


def clip_set_files(directory):
    """Put everything in `directory` on the clipboard as copied files (CF_HDROP)."""
    import win32clipboard as wc
    directory = os.path.abspath(directory)
    if not directory.startswith(os.path.abspath(CLIP_ROOT)) or not os.path.isdir(directory):
        return False
    paths = [os.path.join(directory, n) for n in os.listdir(directory)]
    if not paths:
        return False
    data = struct.pack("<IiiII", 20, 0, 0, 0, 1) + ("\0".join(paths) + "\0\0").encode("utf-16-le")
    for _ in range(3):
        try:
            wc.OpenClipboard()
            try:
                wc.EmptyClipboard()
                wc.SetClipboardData(wc.CF_HDROP, data)
                wc.SetClipboardData(wc.RegisterClipboardFormat("Preferred DropEffect"), struct.pack("<I", 1))
                return True
            finally:
                wc.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return False


def safe_join(base, rel):
    parts = []
    for part in str(rel).replace("\\", "/").split("/"):
        part = "".join(c for c in part if c not in '<>:"|?*' and ord(c) >= 32).strip()
        if part and part not in (".", ".."):
            parts.append(part)
    if not parts:
        raise OSError("Invalid file name")
    return os.path.join(os.path.abspath(base), *parts)


def clip_set(text):
    import win32clipboard as wc
    for _ in range(3):
        try:
            wc.OpenClipboard()
            try:
                wc.EmptyClipboard()
                wc.SetClipboardData(wc.CF_UNICODETEXT, text)
                return True
            finally:
                wc.CloseClipboard()
        except Exception:
            time.sleep(0.03)
    return False


# ----------------------------------------------------------------------------
# File system helpers
# ----------------------------------------------------------------------------
def fs_list(path):
    if not path:
        entries = []
        home = os.path.expanduser("~")
        for label in ("Desktop", "Documents", "Downloads"):
            p = os.path.join(home, label)
            if os.path.isdir(p):
                entries.append({"n": label, "p": p, "d": True, "s": 0, "m": 0})
        mask = kernel32.GetLogicalDrives()
        for i in range(26):
            if mask >> i & 1:
                drive = f"{chr(65 + i)}:\\"
                entries.append({"n": drive, "p": drive, "d": True, "s": 0, "m": 0})
        return {"path": "", "parent": None, "entries": entries}
    path = os.path.abspath(path)
    entries = []
    with os.scandir(path) as it:
        for e in it:
            try:
                st = e.stat()
                entries.append({"n": e.name, "p": e.path, "d": e.is_dir(), "s": st.st_size, "m": int(st.st_mtime)})
            except OSError:
                continue
            if len(entries) >= 5000:
                break
    entries.sort(key=lambda x: (not x["d"], x["n"].lower()))
    parent = os.path.dirname(path)
    return {"path": path, "parent": "" if parent == path else parent, "entries": entries}


def unique_path(directory, name):
    name = os.path.basename(str(name).replace("/", "\\")).strip()
    name = "".join(c for c in name if c not in '<>:"|?*' and ord(c) >= 32) or "file"
    directory = os.path.abspath(directory)
    if not os.path.isdir(directory):
        raise OSError("Destination folder does not exist")
    base, ext = os.path.splitext(name)
    p, i = os.path.join(directory, name), 1
    while os.path.exists(p) or os.path.exists(p + ".part"):
        p = os.path.join(directory, f"{base} ({i}){ext}")
        i += 1
    return p


class WriteHandle:
    """A file being received: written to <name>.part, renamed when complete."""

    def __init__(self, directory, name, rel=None):
        if rel:  # clipboard batch: keep the folder structure inside a private folder
            if not os.path.abspath(directory).startswith(os.path.abspath(CLIP_ROOT)):
                raise OSError("Invalid destination")
            self.path = safe_join(directory, rel)
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
        else:
            self.path = unique_path(directory or os.path.join(os.path.expanduser("~"), "Desktop"), name)
        self.f = open(self.path + ".part", "wb")

    def write(self, data):
        self.f.write(data)

    def close(self, ok):
        self.f.close()
        if ok:
            os.replace(self.path + ".part", self.path)
        else:
            try:
                os.remove(self.path + ".part")
            except OSError:
                pass


# ----------------------------------------------------------------------------
# Screen streaming
# ----------------------------------------------------------------------------
BLOCK = 64


def dirty_rects(prev, cur):
    """Changed regions between two frames (uint32 px arrays) as [(x0,y0,x1,y1)]."""
    d = prev != cur
    if not d.any():
        return []
    h, w = d.shape
    hb, wb = -(-h // BLOCK), -(-w // BLOCK)
    if h % BLOCK or w % BLOCK:
        p = np.zeros((hb * BLOCK, wb * BLOCK), dtype=bool)
        p[:h, :w] = d
        d = p
    blocks = d.reshape(hb, BLOCK, wb, BLOCK).any(axis=(1, 3))
    if blocks.mean() > 0.6:
        return [(0, 0, w, h)]
    rows = blocks.any(axis=1)
    rects, r = [], 0
    while r < hb:
        if not rows[r]:
            r += 1
            continue
        r1 = r
        while r1 < hb and rows[r1]:
            r1 += 1
        cols = np.flatnonzero(blocks[r:r1].any(axis=0))
        rects.append((int(cols[0]) * BLOCK, r * BLOCK, min((int(cols[-1]) + 1) * BLOCK, w), min(r1 * BLOCK, h)))
        r = r1
    if len(rects) > 12:
        rects = [(min(r[0] for r in rects), rects[0][1], max(r[2] for r in rects), rects[-1][3])]
    return rects


def list_monitors():
    with mss.MSS() as sct:
        mons = sct.monitors[1:] or sct.monitors[:1]
        return [{"left": m["left"], "top": m["top"], "width": m["width"], "height": m["height"]} for m in mons]


class Streamer(threading.Thread):
    """Captures one monitor and sends changed regions as JPEG tiles.

    Flow control: at most two frames may be un-acknowledged by the viewer, so
    the frame rate adapts to whatever the network can carry.
    """

    def __init__(self, session):
        super().__init__(daemon=True)
        self.s = session
        self.stop_evt = threading.Event()
        self.ack_evt = threading.Event()
        self.lock = threading.Lock()
        self.mon = 0
        self.quality = "balanced"
        self.gen = 1       # bumped whenever a full frame is needed
        self.sent = 0
        self.acked = 0

    def configure(self, mon=None, quality=None):
        with self.lock:
            if mon is not None:
                self.mon = max(0, int(mon))
            if quality in QUALITY:
                self.quality = quality
            self.gen += 1

    def ack(self, seq):
        self.acked = max(self.acked, int(seq))
        self.ack_evt.set()

    def stop(self):
        self.stop_evt.set()
        self.ack_evt.set()

    def run(self):
        try:
            self._run()
        except Exception:
            log.exception("Screen streamer crashed")

    def _run(self):
        prev = None
        prev_key = None
        done_gen = 0
        last_cur = None
        with mss.MSS() as sct:
            while not self.stop_evt.is_set():
                t0 = time.perf_counter()
                if self.sent - self.acked >= 2:
                    self.ack_evt.wait(0.1)
                    self.ack_evt.clear()
                    continue
                with self.lock:
                    mi, qname, gen = self.mon, self.quality, self.gen
                prof = QUALITY[qname]
                mons = sct.monitors[1:] or sct.monitors[:1]
                mon = mons[mi if mi < len(mons) else 0]
                self.s.mon_rect = {k: mon[k] for k in ("left", "top", "width", "height")}
                shot = sct.grab(mon)
                w, h = shot.size
                raw = shot.bgra
                cur = np.frombuffer(raw, dtype=np.uint32).reshape(h, w)
                key = (mi, w, h, qname)
                full = gen != done_gen or prev is None or key != prev_key
                rects = [(0, 0, w, h)] if full else dirty_rects(prev, cur)
                prev, prev_key, done_gen = cur, key, gen

                pt = wintypes.POINT()
                user32.GetCursorPos(ctypes.byref(pt))
                cx = (pt.x - mon["left"]) / max(1, mon["width"])
                cy = (pt.y - mon["top"]) / max(1, mon["height"])
                c = (round(cx, 4), round(cy, 4)) if 0 <= cx <= 1 and 0 <= cy <= 1 else (-1, -1)
                if c != last_cur:
                    last_cur = c
                    self.s.post({"t": "cur", "x": c[0], "y": c[1]})

                if rects:
                    img = Image.frombuffer("RGB", (w, h), raw, "raw", "BGRX")
                    sw, sh = w, h
                    if prof["maxw"] and w > prof["maxw"]:
                        sw = prof["maxw"]
                        sh = max(1, round(h * sw / w))
                        img = img.resize((sw, sh), Image.BILINEAR)
                    fx, fy = sw / w, sh / h
                    self.sent += 1
                    parts = [struct.pack("<cIBHHB", b"F", self.sent, 1 if full else 0, sw, sh, len(rects))]
                    for (x0, y0, x1, y1) in rects:
                        if sw != w:
                            x0, y0 = int(x0 * fx), int(y0 * fy)
                            x1, y1 = min(sw, int(x1 * fx) + 1), min(sh, int(y1 * fy) + 1)
                        tile = img if (x0, y0, x1, y1) == (0, 0, sw, sh) else img.crop((x0, y0, x1, y1))
                        buf = io.BytesIO()
                        tile.save(buf, "JPEG", quality=prof["q"], subsampling=prof["sub"])
                        data = buf.getvalue()
                        parts.append(struct.pack("<HHHHI", x0, y0, x1 - x0, y1 - y0, len(data)))
                        parts.append(data)
                    self.s.post_bin(b"".join(parts))
                self.stop_evt.wait(max(0.002, 1.0 / prof["fps"] - (time.perf_counter() - t0)))


# ----------------------------------------------------------------------------
# Incoming session (this desk is being viewed)
# ----------------------------------------------------------------------------
CHUNK = 48_000


class HostSession:
    def __init__(self, hub, sid, peer, fps):
        self.hub = hub
        self.sid = sid
        self.peer = {"id": str(peer.get("id", ""))[:16], "name": str(peer.get("name", ""))[:64]}
        self.fps = [str(f) for f in (fps or [])][:2]
        self.state = "hello"
        self.perms = {"control": False, "clipboard": False, "files": False}
        self.nonce = ""
        self.pw_tries = 0
        self.streamer = None
        self.mon_rect = None
        self.pressed = {}
        self.buttons = set()
        self.puts = {}
        self.gets = {}
        self.clip_dirs = {}
        self.timer = None
        self.closed = False

    # -- transport ---------------------------------------------------------
    def send(self, d):
        if not self.closed:
            asyncio.ensure_future(self.hub.ui({"op": "peer_send", "sid": self.sid, "d": d}))

    def post(self, d):  # from other threads
        self.hub.loop.call_soon_threadsafe(self.send, d)

    def post_bin(self, data):
        self.hub.loop.call_soon_threadsafe(self._send_bin, data)

    def _send_bin(self, data):
        if not self.closed:
            asyncio.ensure_future(self.hub.ui_bin(bytes([self.sid]) + data))

    # -- lifecycle ---------------------------------------------------------
    def deny(self, reason):
        self.send({"t": "denied", "reason": reason})
        self.hub.loop.call_later(0.6, lambda: asyncio.ensure_future(self.hub.ui({"op": "peer_kick", "sid": self.sid})))
        self.close()

    def grant(self, perms):
        if self.state != "auth":
            return
        self.state = "active"
        self.perms = {k: bool(perms.get(k)) for k in ("control", "clipboard", "files")}
        if self.timer:
            self.timer.cancel()
        asyncio.ensure_future(self.hub.ui({"op": "incoming_end", "sid": self.sid}))
        mons = list_monitors()
        self.mon_rect = mons[0]
        self.send({"t": "granted", "perms": self.perms, "name": CFG.data["name"], "id": CFG.data["id"],
                   "version": VERSION,
                   "monitors": [{"w": m["width"], "h": m["height"]} for m in mons]})
        log.info("Session %s granted to %s (%s) perms=%s", self.sid, self.peer["name"], self.peer["id"], self.perms)
        self.hub.push_sessions()
        self.hub.clip_sync_state()

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.timer:
            self.timer.cancel()
        if self.streamer:
            self.streamer.stop()
        self.release_inputs()
        for hnd in self.puts.values():
            try:
                hnd.close(False)
            except Exception:
                pass
        self.puts.clear()
        for g in self.gets.values():
            g["cancel"] = True
        self.hub.sessions.pop(self.sid, None)
        asyncio.ensure_future(self.hub.ui({"op": "incoming_end", "sid": self.sid}))
        self.hub.push_sessions()
        log.info("Session %s closed", self.sid)

    def release_inputs(self):
        for code, key in list(self.pressed.items()):
            key_event(code, key, False)
        self.pressed.clear()
        for b in list(self.buttons):
            mouse_button(b, False)
        self.buttons.clear()

    # -- messages ----------------------------------------------------------
    async def on_json(self, m):
        t = m.get("t")
        if self.state == "hello":
            if t != "hello":
                return
            sec = CFG.data["security"]
            can_pw = bool(sec["pw_key"]) and not self.hub.pw_locked()
            can_prompt = sec["interactive"] == "always"
            if not (can_pw or can_prompt):
                return self.deny("Remote access is disabled on this desk.")
            self.nonce = secrets.token_hex(16)
            self.state = "auth"
            self.send({"t": "auth", "pw": can_pw, "prompt": can_prompt, "salt": sec["pw_salt"] if can_pw else "",
                       "nonce": self.nonce, "name": CFG.data["name"]})
            if can_prompt:
                await self.hub.ui({"op": "incoming", "sid": self.sid, "peer": self.peer, "perms": sec["perms"]})
                attention()
            self.timer = self.hub.loop.call_later(120, lambda: self.deny("Request timed out."))
        elif self.state == "auth":
            if t == "auth_pw":
                sec = CFG.data["security"]
                if not sec["pw_key"] or self.hub.pw_locked():
                    return self.send({"t": "auth_fail", "reason": "Password login is unavailable right now."})
                good = make_proof(sec["pw_key"], self.nonce, self.fps)
                if len(self.fps) == 2 and hmac.compare_digest(good, str(m.get("proof", ""))):
                    self.grant(sec["perms"])
                else:
                    self.pw_tries += 1
                    self.hub.pw_fail()
                    log.warning("Wrong password from %s (%s)", self.peer["name"], self.peer["id"])
                    if self.pw_tries >= 3 or self.hub.pw_locked():
                        self.deny("Too many wrong passwords.")
                    else:
                        self.send({"t": "auth_fail", "reason": "Wrong password."})
        elif self.state == "active":
            await self.on_active(t, m)

    async def on_active(self, t, m):
        if t == "ack":
            if self.streamer:
                self.streamer.ack(m.get("seq", 0))
        elif t in ("m", "b", "w", "k", "combo", "relk", "lock"):
            if self.perms["control"]:
                self.on_input(t, m)
        elif t == "start" or t == "set":
            if not self.streamer:
                self.streamer = Streamer(self)
                self.streamer.configure(m.get("monitor"), m.get("quality"))
                self.streamer.start()
            else:
                self.release_inputs()
                self.streamer.configure(m.get("monitor"), m.get("quality"))
        elif t == "ping":
            self.send({"t": "pong", "ts": m.get("ts")})
        elif t == "chat":
            await self.hub.ui({"op": "chat", "sid": self.sid, "name": self.peer["name"], "text": str(m.get("text", ""))[:4000]})
            attention()
        elif t == "clip":
            if self.perms["clipboard"]:
                self.hub.clip_apply(str(m.get("text", ""))[:1_000_000])
        elif t in ("fs_list", "put_start", "put_end", "get_start", "get_ack", "xfer_cancel", "clip_files_set"):
            if not self.perms["files"]:
                return self.send({"t": "fs_err", "rid": m.get("rid"), "xid": m.get("xid"),
                                  "err": "File transfer is not permitted for this session."})
            await self.on_files(t, m)

    def on_input(self, t, m):
        mon = self.mon_rect
        try:
            if t == "m" and mon:
                mouse_move(mon, m["x"], m["y"])
            elif t == "b":
                if mon and "x" in m:
                    mouse_move(mon, m["x"], m["y"])
                b, down = int(m["b"]), bool(m["d"])
                mouse_button(b, down)
                (self.buttons.add if down else self.buttons.discard)(b)
            elif t == "w":
                mouse_wheel(m.get("dx", 0), m.get("dy", 0))
            elif t == "k":
                code, key, down = str(m.get("c", "")), m.get("k"), bool(m["d"])
                key_event(code, key, down)
                if down:
                    self.pressed[code] = key
                else:
                    self.pressed.pop(code, None)
            elif t == "combo":
                codes = [c for c in m.get("keys", []) if c in VK][:6]
                for c in codes:
                    key_event(c, None, True)
                for c in reversed(codes):
                    key_event(c, None, False)
            elif t == "relk":
                self.release_inputs()
            elif t == "lock":
                user32.LockWorkStation()
        except Exception:
            log.exception("Input injection failed")

    async def on_files(self, t, m):
        xid = m.get("xid")
        try:
            if t == "fs_list":
                self.send({"t": "fs_list_r", "rid": m.get("rid"), **fs_list(str(m.get("path", "")))})
            elif t == "put_start":
                if m.get("clip") is not None:  # file copied on the viewer's PC, to be pasted here
                    if not self.perms["clipboard"]:
                        raise OSError("Clipboard is not permitted for this session.")
                    batch = int(m["clip"])
                    if batch not in self.clip_dirs:
                        self.clip_dirs = {batch: clip_new_dir()}
                    self.puts[int(xid)] = WriteHandle(self.clip_dirs[batch], "", rel=str(m["rel"]))
                else:
                    self.puts[int(xid)] = WriteHandle(str(m.get("dir") or ""), str(m["name"]))
                self.send({"t": "put_ok", "xid": xid})
            elif t == "clip_files_set":
                d = self.clip_dirs.get(int(m.get("batch", -1)))
                if d and self.perms["clipboard"]:
                    self.hub.clip_apply_files(d)
            elif t == "put_end":
                hnd = self.puts.pop(int(xid), None)
                if hnd:
                    hnd.close(True)
                    self.send({"t": "put_done", "xid": xid, "path": hnd.path})
            elif t == "get_start":
                g = {"acked": 0, "cancel": False}
                self.gets[int(xid)] = g
                asyncio.ensure_future(self._send_file(int(xid), str(m["path"]), g))
            elif t == "get_ack":
                g = self.gets.get(int(xid))
                if g:
                    g["acked"] = int(m.get("n", 0))
            elif t == "xfer_cancel":
                g = self.gets.get(int(xid))
                if g:
                    g["cancel"] = True
                hnd = self.puts.pop(int(xid), None)
                if hnd:
                    hnd.close(False)
        except Exception as e:
            self.send({"t": "fs_err", "rid": m.get("rid"), "xid": xid, "err": str(e)})

    async def _send_file(self, xid, path, g):
        ok = False
        try:
            size = os.path.getsize(path)
            self.send({"t": "get_info", "xid": xid, "size": size})
            n = 0
            with open(path, "rb") as f:
                while not g["cancel"] and not self.closed:
                    if n - g["acked"] >= 32:
                        await asyncio.sleep(0.005)
                        continue
                    chunk = f.read(CHUNK)
                    if not chunk:
                        ok = True
                        break
                    await self.hub.ui_bin(bytes([self.sid]) + b"D" + struct.pack("<I", xid) + chunk)
                    n += 1
            self.send({"t": "get_end", "xid": xid, "ok": ok})
        except Exception as e:
            self.send({"t": "fs_err", "xid": xid, "err": str(e)})
        finally:
            self.gets.pop(xid, None)

    def on_bin(self, data):
        if self.state != "active" or not self.perms["files"] or len(data) < 5 or data[0:1] != b"D":
            return
        hnd = self.puts.get(struct.unpack_from("<I", data, 1)[0])
        if hnd:
            try:
                hnd.write(data[5:])
            except Exception as e:
                self.send({"t": "fs_err", "xid": struct.unpack_from("<I", data, 1)[0], "err": str(e)})


def attention():
    """Bring the app window to the front (incoming request / chat)."""
    w = WINDOW
    if not w:
        return

    def run():
        try:
            w.restore()
            w.show()
            w.on_top = True
            w.on_top = False
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


# ----------------------------------------------------------------------------
# Hub: the link to the UI
# ----------------------------------------------------------------------------
class Hub:
    def __init__(self, loop):
        self.loop = loop
        self.ws = None
        self.sessions = {}
        self.reads = {}
        self.writes = {}
        self.next_handle = 1
        self.pw_fails = []
        self.viewer_clip = False
        self.clip_task = None
        self.clip_seq = user32.GetClipboardSequenceNumber()

    # -- sending -----------------------------------------------------------
    async def ui(self, obj):
        ws = self.ws
        if ws is not None and not ws.closed:
            try:
                await ws.send_str(json.dumps(obj))
            except Exception:
                pass

    async def ui_bin(self, data):
        ws = self.ws
        if ws is not None and not ws.closed:
            try:
                await ws.send_bytes(data)
            except Exception:
                pass

    def push_sessions(self):
        items = [{"sid": s.sid, "id": s.peer["id"], "name": s.peer["name"], "perms": s.perms}
                 for s in self.sessions.values() if s.state == "active"]
        asyncio.ensure_future(self.ui({"op": "sessions", "items": items}))

    # -- password lockout --------------------------------------------------
    def pw_fail(self):
        self.pw_fails.append(time.time())

    def pw_locked(self):
        cutoff = time.time() - 600
        self.pw_fails = [t for t in self.pw_fails if t > cutoff]
        return len(self.pw_fails) >= 6

    # -- clipboard sync ----------------------------------------------------
    def clip_sync_state(self):
        need = self.viewer_clip or any(s.state == "active" and s.perms["clipboard"] for s in self.sessions.values())
        if need and not self.clip_task:
            self.clip_seq = user32.GetClipboardSequenceNumber()
            self.clip_task = asyncio.ensure_future(self._clip_loop())

    async def _clip_loop(self):
        try:
            while True:
                await asyncio.sleep(0.5)
                hosts = [s for s in self.sessions.values() if s.state == "active" and s.perms["clipboard"]]
                if not hosts and not self.viewer_clip:
                    break
                seq = user32.GetClipboardSequenceNumber()
                if seq == self.clip_seq:
                    continue
                self.clip_seq = seq
                got = clip_read()
                if not got or not got[1]:
                    continue
                kind, value = got
                if kind == "files":
                    try:
                        items = clip_expand(value)
                    except ValueError as e:
                        for s in hosts:
                            s.send({"t": "notice", "text": str(e)})
                        await self.ui({"op": "notice", "text": str(e)})
                        continue
                    if not items:
                        continue
                    for s in hosts:
                        if s.perms["files"]:
                            s.send({"t": "clip_files", "items": items})
                    if self.viewer_clip:
                        await self.ui({"op": "clipboard_files", "items": items})
                elif len(value) <= 1_000_000:
                    for s in hosts:
                        s.send({"t": "clip", "text": value})
                    if self.viewer_clip:
                        await self.ui({"op": "clipboard", "text": value})
        finally:
            self.clip_task = None

    def clip_apply(self, text):
        if text and clip_set(text):
            self.clip_seq = user32.GetClipboardSequenceNumber()

    def clip_apply_files(self, directory):
        ok = clip_set_files(directory)
        if ok:
            self.clip_seq = user32.GetClipboardSequenceNumber()
        return ok

    # -- UI connection -----------------------------------------------------
    def attach(self, ws):
        self.detach()
        self.ws = ws

    def detach(self):
        for s in list(self.sessions.values()):
            s.close()
        for f in self.reads.values():
            f.close()
        self.reads.clear()
        for hnd in self.writes.values():
            hnd.close(False)
        self.writes.clear()
        self.viewer_clip = False
        self.ws = None

    async def on_text(self, m):
        op = m.get("op")
        if op == "rpc":
            rid = m.get("id")
            try:
                fn = getattr(self, "rpc_" + str(m.get("m")))
                r = fn(**(m.get("a") or {}))
                if asyncio.iscoroutine(r):
                    r = await r
                await self.ui({"op": "rpc_r", "id": rid, "r": r})
            except Exception as e:
                log.warning("rpc %s failed: %s", m.get("m"), e)
                await self.ui({"op": "rpc_r", "id": rid, "e": str(e) or e.__class__.__name__})
        elif op == "log":
            log.warning("UI: %s", str(m.get("msg"))[:2000])
        elif op == "peer_open":
            sid = int(m["sid"])
            if 1 <= sid <= 200 and sid not in self.sessions:
                self.sessions[sid] = HostSession(self, sid, m.get("peer") or {}, m.get("fp"))
                log.info("Incoming connection %s from %s", sid, (m.get("peer") or {}).get("id"))
        elif op == "peer_msg":
            s = self.sessions.get(int(m["sid"]))
            if s and isinstance(m.get("d"), dict):
                try:
                    await s.on_json(m["d"])
                except Exception:
                    log.exception("Bad peer message")
        elif op == "peer_close":
            s = self.sessions.get(int(m["sid"]))
            if s:
                s.close()

    def on_binary(self, data):
        if not data:
            return
        if data[0] == 255:  # local download chunk: [255][handle u32][bytes]
            hnd = self.writes.get(struct.unpack_from("<I", data, 1)[0])
            if hnd:
                hnd.write(data[5:])
            return
        s = self.sessions.get(data[0])
        if s:
            s.on_bin(data[1:])

    # -- RPC ---------------------------------------------------------------
    def rpc_get_state(self):
        return CFG.public()

    def rpc_set_config(self, patch):
        d = CFG.data
        if "name" in patch:
            d["name"] = str(patch["name"]).strip()[:64] or socket.gethostname()
        sec = patch.get("security") or {}
        if sec.get("interactive") in ("always", "never"):
            d["security"]["interactive"] = sec["interactive"]
        for k in ("control", "clipboard", "files"):
            if k in (sec.get("perms") or {}):
                d["security"]["perms"][k] = bool(sec["perms"][k])
        disp = patch.get("display") or {}
        if disp.get("quality") in QUALITY:
            d["display"]["quality"] = disp["quality"]
        if disp.get("view") in VIEWS:
            d["display"]["view"] = disp["view"]
        if "show_cursor" in disp:
            d["display"]["show_cursor"] = bool(disp["show_cursor"])
        net = patch.get("network") or {}
        if isinstance(net.get("brokers"), list):
            brokers = [str(b).strip() for b in net["brokers"] if str(b).strip().startswith(("wss://", "ws://"))][:8]
            d["network"]["brokers"] = brokers or list(DEFAULT_BROKERS)
        if isinstance(net.get("ice"), list):
            ice = []
            for s in net["ice"][:8]:
                urls = str(s.get("urls", "")).strip()
                if not urls.startswith(("stun:", "turn:", "turns:")):
                    continue
                item = {"urls": urls}
                if s.get("username"):
                    item["username"] = str(s["username"])
                    item["credential"] = str(s.get("credential", ""))
                ice.append(item)
            d["network"]["ice"] = ice or [dict(x) for x in DEFAULT_ICE]
        gen = patch.get("general") or {}
        if "autostart" in gen:
            set_autostart(bool(gen["autostart"]))
            d["general"]["autostart"] = bool(gen["autostart"])
        CFG.save()
        return CFG.public()

    def rpc_set_password(self, password):
        sec = CFG.data["security"]
        if password:
            if len(password) < 8:
                raise ValueError("Use at least 8 characters.")
            sec["pw_salt"] = secrets.token_hex(16)
            sec["pw_key"] = derive_key(password, sec["pw_salt"])
        else:
            sec["pw_salt"] = sec["pw_key"] = ""
        CFG.save()
        return CFG.public()

    def _recent(self, rid, create=False):
        rid = "".join(c for c in str(rid) if c.isdigit())[:12]
        for r in CFG.data["recents"]:
            if r["id"] == rid:
                return r
        if create and rid:
            r = {"id": rid}
            CFG.data["recents"].insert(0, r)
            return r
        return None

    def rpc_recent_touch(self, id, name=""):
        r = self._recent(id, True)
        if r:
            if name:
                r["name"] = str(name)[:64]
            r["last"] = int(time.time())
            rec = CFG.data["recents"]
            rec.remove(r)
            rec.insert(0, r)
            del rec[40:]
            CFG.save()
        return CFG.public()

    def rpc_recent_edit(self, id, alias=None, remove=False, forget=False):
        r = self._recent(id)
        if r:
            if remove:
                CFG.data["recents"].remove(r)
            if alias is not None:
                r["alias"] = str(alias)[:64]
            if forget:
                r.pop("key", None)
                r.pop("salt", None)
            CFG.save()
        return CFG.public()

    def rpc_auth_proof(self, id, salt, nonce, fps, password=None, remember=False):
        """Compute the login proof for a remote desk (viewer side)."""
        r = self._recent(id, True)
        if password is not None:
            key = derive_key(password, salt)
            if remember:
                r["key"], r["salt"] = key, salt
                CFG.save()
        elif r.get("key") and r.get("salt") == salt:
            key = r["key"]
        else:
            return {"proof": None}
        return {"proof": make_proof(key, nonce, fps)}

    def rpc_incoming_reply(self, sid, accept, perms=None):
        s = self.sessions.get(int(sid))
        if s and s.state == "auth":
            if accept:
                s.grant(perms or {})
            else:
                s.deny("The remote user declined the request.")
        return True

    def rpc_session_end(self, sid):
        s = self.sessions.get(int(sid))
        if s:
            s.send({"t": "bye"})
            self.loop.call_later(0.3, lambda: asyncio.ensure_future(self.ui({"op": "peer_kick", "sid": int(sid)})))
            s.close()
        return True

    def rpc_chat_send(self, sid, text):
        s = self.sessions.get(int(sid))
        if s and s.state == "active":
            s.send({"t": "chat", "text": str(text)[:4000]})
        return True

    def rpc_fs_list(self, path=""):
        return fs_list(path)

    def rpc_fopen_r(self, path):
        h = self.next_handle
        self.next_handle += 1
        self.reads[h] = open(path, "rb")
        return {"h": h, "size": os.path.getsize(path)}

    def rpc_fread(self, h):
        return {"b64": base64.b64encode(self.reads[int(h)].read(CHUNK)).decode()}

    def rpc_fopen_w(self, dir, name, rel=None):
        h = self.next_handle
        self.next_handle += 1
        self.writes[h] = WriteHandle(dir, name, rel=rel)
        return {"h": h, "path": self.writes[h].path}

    def rpc_clip_begin(self):
        return {"dir": clip_new_dir()}

    def rpc_clip_set_files(self, dir):
        return self.clip_apply_files(dir)

    def rpc_fclose(self, h, ok=True):
        f = self.reads.pop(int(h), None)
        if f:
            f.close()
        hnd = self.writes.pop(int(h), None)
        if hnd:
            hnd.close(bool(ok))
        return True

    def rpc_clip_watch(self, on):
        self.viewer_clip = bool(on)
        self.clip_sync_state()
        return True

    def rpc_clip_set(self, text):
        self.clip_apply(str(text)[:1_000_000])
        return True

    def rpc_save_screenshot(self, b64):
        folder = os.path.join(os.path.expanduser("~"), "Pictures", "OpenDesk")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, time.strftime("screenshot-%Y%m%d-%H%M%S.png"))
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        return {"path": path}

    def rpc_fullscreen(self):
        if WINDOW:
            WINDOW.toggle_fullscreen()
            return {"native": True}
        return {"native": False}


HUB = None


# ----------------------------------------------------------------------------
# Local web server (127.0.0.1 only)
# ----------------------------------------------------------------------------
async def ws_handler(request):
    port = request.app["port"]
    origin = request.headers.get("Origin", "")
    if not hmac.compare_digest(request.query.get("t", ""), TOKEN) or origin not in (
            f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
        return web.Response(status=403, text="forbidden")
    ws = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    HUB.attach(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    await HUB.on_text(json.loads(msg.data))
                except Exception:
                    log.exception("UI message failed")
            elif msg.type == WSMsgType.BINARY:
                HUB.on_binary(msg.data)
    finally:
        if HUB.ws is ws:
            HUB.detach()
    return ws


@web.middleware
async def no_cache(request, handler):
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def run_server(port, ready):
    global HUB
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    HUB = Hub(loop)
    app = web.Application(middlewares=[no_cache])
    app["port"] = port
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/", lambda r: web.FileResponse(os.path.join(STATIC_DIR, "index.html")))
    app.router.add_static("/static", STATIC_DIR)
    runner = web.AppRunner(app, access_log=None)
    loop.run_until_complete(runner.setup())
    loop.run_until_complete(web.TCPSite(runner, host="127.0.0.1", port=port).start())
    ready.set()
    loop.run_forever()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    global WINDOW
    # One instance per profile: two would fight over the same Desk ID.
    kernel32.CreateMutexW(None, False, "OpenDesk-" + (_safe_profile or "default"))
    if kernel32.GetLastError() == 183:
        user32.MessageBoxW(None, "OpenDesk is already running.", "OpenDesk", 0x40)
        return

    port = ARGS.port or free_port()
    ready = threading.Event()
    threading.Thread(target=run_server, args=(port, ready), daemon=True).start()
    if not ready.wait(10):
        log.error("Local server failed to start")
        return
    url = f"http://127.0.0.1:{port}/?t={TOKEN}"
    log.info("OpenDesk %s started, desk id %s, config %s", VERSION, CFG.data["id"], CONFIG_DIR)

    if ARGS.headless:
        with open(os.path.join(CONFIG_DIR, "dev-url.txt"), "w") as f:
            f.write(url)
        print(url, flush=True)
        threading.Event().wait()
        return

    # Keep the embedded browser fully awake while the window is minimized (it
    # carries the session traffic), and use real LAN addresses for same-network peers.
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
        "--disable-background-timer-throttling --disable-renderer-backgrounding "
        "--disable-backgrounding-occluded-windows --disable-features=WebRtcHideLocalIpsWithMdns "
        "--autoplay-policy=no-user-gesture-required"
    )
    import webview
    WINDOW = webview.create_window("OpenDesk", url, width=1100, height=720, min_size=(860, 560),
                                   minimized=ARGS.minimized)
    webview.start()
    try:
        for s in list(HUB.sessions.values()):
            s.release_inputs()
    finally:
        os._exit(0)


if __name__ == "__main__":
    main()
