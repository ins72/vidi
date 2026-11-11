#!/bin/bash
# Measures how long an upstream HLS token stays valid. Run in a screen/tmux; takes ~65 minutes.
# Usage: ./measure-token-lifetime.sh [imdb] [movie|series] [season] [episode]
IMDB=${1:-tt0111161}; TYPE=${2:-movie}; S=$3; E=$4
G="https://server.mewayz.com/streamgrabber/grab?imdb=$IMDB&type=$TYPE"
[ "$TYPE" = series ] && G="$G&season=$S&episode=$E"
M=$(curl -s "$G" | jq -r '.stream_urls[0]')
V=$(curl -s "$M" | grep -m1 '^https'); SEG=$(curl -s "$V" | grep -m1 '^https')
echo "start $(date -u +%H:%M:%S)"
for MIN in 0 5 15 30 45 60; do
  [ "$MIN" -gt 0 ] && sleep $(( (MIN - PREV) * 60 ))
  PREV=$MIN
  a=$(curl -s -o /dev/null -w '%{http_code}' "$M")
  b=$(curl -s -o /dev/null -w '%{http_code}' "$V")
  c=$(curl -s -o /dev/null -w '%{http_code}' -r 0-1023 "$SEG")
  echo "t+${MIN}m master=$a variant=$b segment=$c"
done
