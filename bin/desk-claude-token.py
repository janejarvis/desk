# Makes the Desk its own long-lived Claude key (claude setup-token) and keeps it in the macOS Keychain
# ("desk-claude-token"), so Desk replies and the Call Center copilot stop sharing the everyday sign-in
# (8 Nov 2026: they renewed it at the same moment each morning, Claude cancelled it, Diogo signed in again
# every day). The key itself is never shown: it is replaced by [saved] in what the window prints.
import os, pty, re, select, subprocess, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp("claude", ["claude", "setup-token"])
buf, tok, pend = b"", None, b""
KEY = re.compile(rb"sk-ant-[A-Za-z0-9_\-]{20,}")
def show(b): os.write(1, KEY.sub(b"[saved]", b))
while True:
    r, _, _ = select.select([fd, 0], [], [], 0.5)
    if not r and pend and not re.search(rb"sk-ant-[A-Za-z0-9_\-]*$", pend): show(pend); pend = b""  # a prompt with no line end
    if fd in r:
        try: data = os.read(fd, 4096)
        except OSError: data = b""
        if not data: break
        buf = (buf + data)[-20000:]
        m = KEY.search(buf.replace(b"\r", b"").replace(b"\n", b""))
        if m: tok = m.group(0)
        pend += data
        if b"\n" in pend:  # whole lines only, so a key split across two reads is still hidden
            head, _, pend = pend.rpartition(b"\n"); show(head + b"\n")
    if 0 in r:
        d = os.read(0, 4096)
        if d: os.write(fd, d)
if pend: show(pend)
_, status = os.waitpid(pid, 0)
if not tok:
    print("\nNo key came back from Claude, so nothing was saved."); sys.exit(1)
subprocess.run(["security", "add-generic-password", "-U", "-s", "desk-claude-token", "-a", os.environ.get("USER", "desk"), "-w", tok.decode()], check=True)
print("\nSaved: the Desk now has its own Claude key (in the Keychain as desk-claude-token).")
