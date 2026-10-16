# Runs one Jupyter kernel for Switchdesk's notebook view and talks JSON lines over stdin/stdout.
#
# In:  {"op": "execute", "id": "...", "code": "..."} | {"op": "interrupt"} | {"op": "restart"} | {"op": "shutdown"}
#      {"op": "complete", "id": "...", "code": "...", "pos": 12}
# Out: {"type": "ready", "kernel": "python3", "language": "python"}
#      {"type": "output", "id": "...", "output": <an nbformat output>}
#      {"type": "count", "id": "...", "count": 3}
#      {"type": "done", "id": "...", "status": "ok" | "error" | "aborted"}
#      {"type": "status", "state": "busy" | "idle" | "restarting" | "dead"}
#      {"type": "error", "message": "..."}
import json
import queue
import sys
import threading

out_lock = threading.Lock()


def emit(msg):
    with out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


try:
    from jupyter_client import KernelManager
except Exception:  # noqa: BLE001
    emit({"type": "error", "message": "missing-jupyter"})
    sys.exit(3)

name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "python3"
km = KernelManager(kernel_name=name)
try:
    km.start_kernel()
except Exception as e:  # noqa: BLE001
    emit({"type": "error", "message": "Couldn't start the %s kernel: %s" % (name, e)})
    sys.exit(4)
kc = km.client()
kc.start_channels()
try:
    kc.wait_for_ready(timeout=60)
except Exception as e:  # noqa: BLE001
    emit({"type": "error", "message": "The kernel didn't start: %s" % e})
    sys.exit(5)

info = km.kernel_spec
emit({"type": "ready", "kernel": name, "language": getattr(info, "language", "python"), "display": getattr(info, "display_name", name)})

runs = {}  # kernel msg_id -> our id
replies = {}  # kernel msg_id -> how it ended (ok, error, aborted)
commands = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        line = line.strip()
        if line:
            try:
                commands.put(json.loads(line))
            except ValueError:
                pass
    commands.put({"op": "shutdown"})


threading.Thread(target=read_stdin, daemon=True).start()


def output_of(msg):
    t = msg["msg_type"]
    c = msg["content"]
    if t == "stream":
        return {"output_type": "stream", "name": c.get("name", "stdout"), "text": c.get("text", "")}
    if t in ("display_data", "execute_result"):
        o = {"output_type": t, "data": c.get("data", {}), "metadata": c.get("metadata", {})}
        if t == "execute_result":
            o["execution_count"] = c.get("execution_count")
        return o
    if t == "error":
        return {"output_type": "error", "ename": c.get("ename", ""), "evalue": c.get("evalue", ""), "traceback": c.get("traceback", [])}
    return None


def handle(cmd):
    op = cmd.get("op")
    if op == "execute":
        msg_id = kc.execute(cmd.get("code", ""), allow_stdin=False, stop_on_error=True)
        runs[msg_id] = cmd.get("id")
    elif op == "complete":
        msg_id = kc.complete(cmd.get("code", ""), cmd.get("pos"))
        runs[msg_id] = ("complete", cmd.get("id"))
    elif op == "interrupt":
        km.interrupt_kernel()
    elif op == "restart":
        emit({"type": "status", "state": "restarting"})
        for ours in list(runs.values()):
            if not isinstance(ours, tuple):
                emit({"type": "done", "id": ours, "status": "aborted"})
        runs.clear()
        km.restart_kernel(now=True)
        kc.wait_for_ready(timeout=60)
        emit({"type": "status", "state": "idle"})
    elif op == "shutdown":
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        finally:
            sys.exit(0)


while True:
    try:
        while True:
            handle(commands.get_nowait())
    except queue.Empty:
        pass
    # Replies on the shell channel: completions, and how each run ended.
    while True:
        try:
            msg = kc.get_shell_msg(timeout=0)
        except queue.Empty:
            break
        ours = runs.get(msg["parent_header"].get("msg_id"))
        if isinstance(ours, tuple):
            c = msg["content"]
            emit({"type": "completions", "id": ours[1], "matches": c.get("matches", []), "start": c.get("cursor_start"), "end": c.get("cursor_end")})
            runs.pop(msg["parent_header"].get("msg_id"), None)
        elif ours is not None:
            replies[msg["parent_header"].get("msg_id")] = msg["content"].get("status", "ok")
    if not km.is_alive():
        emit({"type": "status", "state": "dead"})
        for ours in list(runs.values()):
            if not isinstance(ours, tuple):
                emit({"type": "done", "id": ours, "status": "aborted"})
        runs.clear()
        km.restart_kernel(now=True)
        kc.wait_for_ready(timeout=60)
        emit({"type": "status", "state": "idle"})
    try:
        msg = kc.get_iopub_msg(timeout=0.05)
    except queue.Empty:
        continue
    t = msg["msg_type"]
    parent = msg["parent_header"].get("msg_id")
    if t == "status":
        state = msg["content"].get("execution_state")
        emit({"type": "status", "state": state})
        # A run is over once the kernel is idle after it: its outputs have all arrived by then.
        ours = runs.get(parent)
        if state == "idle" and ours is not None and not isinstance(ours, tuple):
            try:
                reply = kc.get_shell_msg(timeout=2)
                if reply["parent_header"].get("msg_id") == parent:
                    replies[parent] = reply["content"].get("status", "ok")
                else:
                    other = runs.get(reply["parent_header"].get("msg_id"))
                    if isinstance(other, tuple):
                        c = reply["content"]
                        emit({"type": "completions", "id": other[1], "matches": c.get("matches", []), "start": c.get("cursor_start"), "end": c.get("cursor_end")})
                        runs.pop(reply["parent_header"].get("msg_id"), None)
                    else:
                        replies[reply["parent_header"].get("msg_id")] = reply["content"].get("status", "ok")
            except queue.Empty:
                pass
            emit({"type": "done", "id": ours, "status": replies.pop(parent, "ok")})
            runs.pop(parent, None)
        continue
    ours = runs.get(parent)
    if ours is None or isinstance(ours, tuple):
        continue
    if t == "execute_input":
        emit({"type": "count", "id": ours, "count": msg["content"].get("execution_count")})
    elif t == "clear_output":
        emit({"type": "clear", "id": ours, "wait": msg["content"].get("wait", False)})
    else:
        o = output_of(msg)
        if o:
            emit({"type": "output", "id": ours, "output": o})
