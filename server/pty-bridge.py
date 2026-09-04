#!/usr/bin/env python3
"""Small dependency-free PTY bridge for local Agent CLIs.

Stepsemble starts this helper only for an allow-listed executable.  The helper
gives that executable a real Unix terminal while keeping its master side on
stdin/stdout, so the Node supervisor can stream output over SSE and forward
messages from the browser.  Windows does not use this file; the Node service
falls back to ordinary pipes there.
"""

import errno
import fcntl
import os
import pty
import selectors
import signal
import struct
import sys
import termios


def set_window_size(fd: int) -> None:
    """Give interactive TUIs a sensible initial viewport."""
    try:
        columns = max(40, int(os.environ.get("STEPSEMBLE_PTY_COLS", os.environ.get("PI_HARBOR_PTY_COLS", "120"))))
        rows = max(10, int(os.environ.get("STEPSEMBLE_PTY_ROWS", os.environ.get("PI_HARBOR_PTY_ROWS", "40"))))
        winsize = struct.pack("HHHH", rows, columns, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except (AttributeError, OSError, ValueError):
        pass


def write_all(fd: int, data: bytes) -> bool:
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except (BrokenPipeError, OSError) as error:
            if getattr(error, "errno", None) in (errno.EPIPE, errno.EBADF):
                return False
            raise
        if written <= 0:
            return False
        view = view[written:]
    return True


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1]:
        print("stepsemble PTY bridge: executable path required", file=sys.stderr)
        return 64

    executable = sys.argv[1]
    argv = [executable, *sys.argv[2:]]
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        # The Node supervisor already sets cwd and environment.  execv keeps
        # the allow-listed absolute path intact and never invokes a shell.
        try:
            os.execv(executable, argv)
        except OSError as error:
            print(f"stepsemble PTY bridge: could not start agent: {error}", file=sys.stderr)
            os._exit(127)

    set_window_size(master_fd)
    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "pty")
    pty_open = True
    stdin_open = True
    try:
        os.set_blocking(master_fd, False)
        os.set_blocking(sys.stdin.fileno(), False)
        selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "stdin")
    except (AttributeError, OSError):
        pass

    child_status = None

    def close_pty():
        nonlocal pty_open
        if not pty_open:
            return
        pty_open = False
        try:
            selector.unregister(master_fd)
        except Exception:
            pass

    def terminate_child(_signum, _frame):
        try:
            os.kill(child_pid, signal.SIGTERM)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGINT, terminate_child)

    try:
        while True:
            # Reap without blocking so output already buffered in the PTY is
            # forwarded before the bridge exits.
            if child_status is None:
                waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
                if waited_pid == child_pid:
                    child_status = status

            events = selector.select(0.15)
            if not events and child_status is not None:
                if not pty_open:
                    break
                try:
                    probe = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno in (errno.EIO, errno.EBADF):
                        close_pty()
                        probe = b""
                    else:
                        raise
                if probe and write_all(sys.stdout.fileno(), probe):
                    continue
                close_pty()
                break

            for key, _mask in events:
                if key.data == "pty":
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError as error:
                        if error.errno in (errno.EIO, errno.EBADF):
                            close_pty()
                            data = b""
                        else:
                            raise
                    if data:
                        if not write_all(sys.stdout.fileno(), data):
                            return 0
                    elif child_status is not None:
                        close_pty()
                        break
                elif key.data == "stdin" and stdin_open:
                    try:
                        data = os.read(sys.stdin.fileno(), 65536)
                    except OSError as error:
                        if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                            continue
                        data = b""
                    if data:
                        try:
                            if not write_all(master_fd, data):
                                stdin_open = False
                        except OSError:
                            stdin_open = False
                    else:
                        stdin_open = False
                        try:
                            selector.unregister(sys.stdin.fileno())
                        except Exception:
                            pass
                        # EOF from the browser should behave like Ctrl-D, not
                        # keep a child alive forever waiting for more input.
                        try:
                            os.write(master_fd, b"\x04")
                        except OSError:
                            pass

            if child_status is not None and not events:
                break
    finally:
        try:
            selector.close()
        except Exception:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    if child_status is None:
        _pid, child_status = os.waitpid(child_pid, 0)
    if os.WIFEXITED(child_status):
        return os.WEXITSTATUS(child_status)
    if os.WIFSIGNALED(child_status):
        return 128 + os.WTERMSIG(child_status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
