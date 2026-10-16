# Runs on the SSH host for a Switchdesk window with an SSH folder open. Switchdesk starts it with
# `ssh host python3 -u -c ...` and talks JSON lines over stdin/stdout: one request per line,
# {"id": 1, "op": "read", ...}, answered with {"id": 1, "ok": ...} or {"id": 1, "error": "..."}.
# Unprompted lines ({"event": "changed", "rels": [...]}) say which files changed on the host.
# Plain Python 3 standard library only, so nothing needs installing on the host.
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

IGNORED = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache", "target", ".idea", ".DS_Store"}
MAX_FILE = 10 * 1024 * 1024
lock = threading.Lock()


def emit(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def run(argv, cwd, input_bytes=None, env=None, timeout=120):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(argv, cwd=cwd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def is_repo(root):
    try:
        code, out, _ = run(["git", "rev-parse", "--show-toplevel"], root, timeout=15)
        return out.decode().strip() if code == 0 else None
    except Exception:  # noqa: BLE001
        return None


def walk(root, limit=20000):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED)
        rel = os.path.relpath(dirpath, root)
        for f in sorted(filenames):
            out.append(f if rel == "." else rel.replace(os.sep, "/") + "/" + f)
            if len(out) >= limit:
                return out
    return out


def list_files(root):
    if is_repo(root):
        code, out, _ = run(["git", "ls-files", "-co", "--exclude-standard", "-z"], root, timeout=30)
        if code == 0:
            return [f for f in out.decode("utf8", "replace").split("\0") if f][:50000]
    return walk(root)


def read(path):
    st = os.stat(path)
    if st.st_size > MAX_FILE:
        return {"tooLarge": True}
    with open(path, "rb") as f:
        data = f.read()
    if b"\0" in data[:8000]:
        return {"binary": True, "b64": base64.b64encode(data).decode() if st.st_size < 2 * 1024 * 1024 else None}
    return {"content": data.decode("utf8", "replace"), "mtime": st.st_mtime}


def write(path, content=None, b64=None):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    data = base64.b64decode(b64) if b64 is not None else content.encode("utf8")
    with open(path, "wb") as f:
        f.write(data)
    return True


# Files with a likely match, and their text, for Switchdesk's search to match exactly.
def search(root, files, pattern, case_sensitive, limit_bytes=2 * 1024 * 1024):
    try:
        rx = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
    except re.error:
        rx = None
    found = {}
    total = 0
    for rel in files:
        p = os.path.join(root, rel)
        try:
            if os.path.getsize(p) > limit_bytes:
                continue
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue
        text = data.decode("utf8", "replace")
        if rx is None or rx.search(text):
            found[rel] = text
            total += len(text)
            if total > 30 * 1024 * 1024:
                break
    return found


# ---------- snapshots: how the folder was before an agent's turn, to show what it changed

def write_tree(top):
    fd, idx = tempfile.mkstemp(prefix="switchdesk-index-")
    os.close(fd)
    try:
        env = {"GIT_INDEX_FILE": idx}
        shutil.copyfile(os.path.join(top, ".git", "index"), idx) if os.path.exists(os.path.join(top, ".git", "index")) else None
        run(["git", "add", "-A", "."], top, env=env, timeout=120)
        code, out, err = run(["git", "write-tree"], top, env=env, timeout=60)
        return out.decode().strip() if code == 0 else None
    finally:
        try:
            os.remove(idx)
        except OSError:
            pass


def snapshot(root):
    top = is_repo(root)
    if not top:
        return None
    return {"top": top, "tree": write_tree(top)}


def blob(top, tree, rel):
    code, out, _ = run(["git", "show", "%s:%s" % (tree, rel)], top, timeout=30)
    return out if code == 0 else b""


def changes(root, snap, touched):
    out = {}
    if snap and snap.get("tree"):
        top = snap["top"]
        after = write_tree(top)
        code, diff, _ = run(["git", "diff-tree", "-r", "--no-renames", "--name-status", "-z", snap["tree"], after], top, timeout=60)
        parts = diff.decode("utf8", "replace").split("\0")
        i = 0
        while i + 1 < len(parts):
            status, rel = parts[i], parts[i + 1]
            i += 2
            p = os.path.join(top, rel)
            before = b"" if status == "A" else blob(top, snap["tree"], rel)
            try:
                with open(p, "rb") as f:
                    now = f.read()
            except OSError:
                now = None
            out[p] = (before, now, status == "A")
    for p, b64 in (touched or {}).items():
        if p in out:
            continue
        before = base64.b64decode(b64) if b64 is not None else None
        try:
            with open(p, "rb") as f:
                now = f.read()
        except OSError:
            now = None
        if before == now:
            continue
        out[p] = (before or b"", now, before is None)
    res = []
    for p, (before, now, created) in out.items():
        binary = b"\0" in before[:8000] or (now is not None and b"\0" in now[:8000])
        res.append({
            "path": p,
            "before": "" if binary else before.decode("utf8", "replace"),
            "after": "" if binary or now is None else now.decode("utf8", "replace"),
            "beforeB64": base64.b64encode(before).decode() if len(before) < 5 * 1024 * 1024 else None,
            "created": created,
            "deleted": now is None,
            "binary": binary,
        })
    return res


# ---------- watching: which files changed, every couple of seconds

watching = {}


def watch_loop():
    seen = {}
    while True:
        time.sleep(2)
        for root in list(watching):
            changed = []
            now = {}
            count = 0
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d not in IGNORED]
                for f in filenames:
                    p = os.path.join(dirpath, f)
                    try:
                        m = os.stat(p).st_mtime
                    except OSError:
                        continue
                    now[p] = m
                    count += 1
                    if seen.get(root) is not None and seen[root].get(p) != m:
                        changed.append(os.path.relpath(p, root).replace(os.sep, "/"))
                if count > 30000:
                    break
            if seen.get(root) is not None:
                for p in seen[root]:
                    if p not in now:
                        changed.append(os.path.relpath(p, root).replace(os.sep, "/"))
            seen[root] = now
            if changed:
                emit({"event": "changed", "root": root, "rels": changed[:500]})


def handle(m):
    op = m.get("op")
    if op == "hello":
        return {"home": os.path.expanduser("~"), "python": sys.version.split()[0], "git": shutil.which("git") is not None}
    if op == "resolve":
        p = os.path.abspath(os.path.expanduser(m["path"]))
        return {"path": p, "isDir": os.path.isdir(p), "exists": os.path.exists(p)}
    if op == "dirs":
        p = os.path.abspath(os.path.expanduser(m.get("path") or "~"))
        return {"path": p, "dirs": sorted(d for d in os.listdir(p) if os.path.isdir(os.path.join(p, d)) and not d.startswith("."))[:500]}
    if op == "list":
        return list_files(m["root"])
    if op == "read":
        return read(m["path"])
    if op == "write":
        return write(m["path"], m.get("content"), m.get("b64"))
    if op == "stat":
        try:
            st = os.stat(m["path"])
            return {"exists": True, "isFile": os.path.isfile(m["path"]), "size": st.st_size, "mtime": st.st_mtime}
        except OSError:
            return {"exists": False}
    if op == "remove":
        p = m["path"]
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        elif os.path.exists(p):
            os.remove(p)
        return True
    if op == "rename":
        os.makedirs(os.path.dirname(m["to"]) or ".", exist_ok=True)
        os.rename(m["from"], m["to"])
        return True
    if op == "mkdir":
        os.makedirs(m["path"], exist_ok=True)
        return True
    if op == "exec":
        code, out, err = run(m["argv"], m.get("cwd"), base64.b64decode(m["input"]) if m.get("input") else None, m.get("env"), m.get("timeout", 120))
        return {"code": code, "stdout": base64.b64encode(out).decode(), "stderr": err.decode("utf8", "replace")[-8000:]}
    if op == "search":
        return search(m["root"], m["files"], m["pattern"], m.get("caseSensitive"))
    if op == "snapshot":
        return snapshot(m["root"])
    if op == "changes":
        return changes(m["root"], m.get("snap"), m.get("touched"))
    if op == "watch":
        watching[m["root"]] = True
        return True
    raise ValueError("unknown op %s" % op)


def serve(m):
    try:
        emit({"id": m.get("id"), "ok": handle(m)})
    except Exception as e:  # noqa: BLE001
        emit({"id": m.get("id"), "error": "%s: %s" % (type(e).__name__, e)})


threading.Thread(target=watch_loop, daemon=True).start()
emit({"event": "ready"})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    # Slow requests (search, git, snapshots) don't hold up quick ones (reading a file).
    if msg.get("op") in ("search", "exec", "snapshot", "changes", "list"):
        threading.Thread(target=serve, args=(msg,), daemon=True).start()
    else:
        serve(msg)
