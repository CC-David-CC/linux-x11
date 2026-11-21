import os

os.setgroups([])
os.setgid(1000)
os.setuid(1000)
os.execv('/bin/sh', ['sh','/x11/session.sh'])
