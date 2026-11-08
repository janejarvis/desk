# Makes the Desk its own long-lived Claude key (claude setup-token) and keeps it in the macOS Keychain
# ("desk-claude-token"), so Desk replies and the Call Center copilot stop sharing the everyday sign-in
# (8 Nov 2026: they renewed it at the same moment each morning, Claude cancelled it, Diogo signed in again
# every day). The key itself is never shown: it is replaced by [saved] in what the window prints.
import fcntl, os, pty, re, select, struct, subprocess, sys, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp("claude", ["claude", "setup-token"])
# A very wide window, so Claude prints the key on one line: at the normal width it wrapped it with
# indentation and colour codes in between, and only part of it was saved (8 Nov 2026: a 79-letter key, refused).
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]")
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
        for m in KEY.finditer(ANSI.sub(b"", buf)):
            if not tok or len(m.group(0)) >= len(tok): tok = m.group(0)
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
# Try the key before keeping it: a bad key in the Keychain stops every Desk reply.
env = {**os.environ, "CLAUDE_CODE_OAUTH_TOKEN": tok.decode(), "ENABLE_CLAUDEAI_MCP_SERVERS": "false"}
t = subprocess.run(["claude", "-p", "reply with just: ok", "--model", "claude-haiku-4-5-20251001"], env=env, capture_output=True, text=True, timeout=120)
if t.returncode != 0 or "401" in t.stdout + t.stderr or "authenticate" in (t.stdout + t.stderr).lower():
    print("\nClaude refused the key it gave, so nothing was saved (the Desk keeps using the usual sign-in)."); sys.exit(1)
subprocess.run(["security", "add-generic-password", "-U", "-s", "desk-claude-token", "-a", os.environ.get("USER", "desk"), "-w", tok.decode()], check=True)
print("\nSaved: the Desk now has its own Claude key (in the Keychain as desk-claude-token).")
