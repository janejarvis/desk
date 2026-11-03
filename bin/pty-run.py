# Runs a command in a hidden pseudo-terminal, so sign-in tools that want a terminal (vercel login,
# claude auth login) work without a Terminal window opening. Its screen goes to stdout; what the Desk
# writes to stdin is typed into it. The exit code is passed through. (3 Nov 2026)
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp("/bin/zsh", ["/bin/zsh", "-lc", sys.argv[1]])
stdin_open = True
while True:
    rs = [fd] + ([0] if stdin_open else [])
    try: r, _, _ = select.select(rs, [], [], 0.5)
    except InterruptedError: continue
    if fd in r:
        try: data = os.read(fd, 4096)
        except OSError: data = b""
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if not data: stdin_open = False
        else: os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8)
