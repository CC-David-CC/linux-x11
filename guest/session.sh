#!/bin/sh
cd /home/guest || exit 1
twm -f /x11/twmrc &
xclock -geometry 150x150+610+20 &
exec xterm -fn 9x15 -geometry 62x27+10+20
