import errno
import os
import pty
import signal
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)


def stop(signum, frame):
    if child.poll() is None:
        child.kill()
    child.wait()
    sys.exit(124)


signal.signal(signal.SIGTERM, stop)
try:
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    sys.exit(child.wait())
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
    child.wait()
