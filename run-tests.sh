#!/bin/sh
# Runs the logic tests for app.js.
#
# There's no test framework to install: macOS ships Apple's JavaScript engine
# (jsc), so we fake up just enough of a browser, load the real app.js, and check
# the scoring and optimizer against live projection data.
#
# Usage:  sh run-tests.sh          (add --fresh to re-download the data)

set -e

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
DIR=.testdata
POS='position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF'

[ -x "$JSC" ] || { echo "Can't find jsc at $JSC"; exit 1; }
[ "$1" = "--fresh" ] && rm -rf "$DIR"
mkdir -p "$DIR"

# Ask Sleeper which season we're in, so the fixtures don't go stale each year.
SEASON=$(curl -s https://api.sleeper.app/v1/state/nfl |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["season"])')
echo "season: $SEASON"

if [ ! -f "$DIR/season.json" ]; then
  echo "downloading season-long projections…"
  curl -s "https://api.sleeper.app/projections/nfl/$SEASON?season_type=regular&order_by=pts_half_ppr&$POS" \
    -o "$DIR/season.json"
fi
if [ ! -f "$DIR/week1.json" ]; then
  echo "downloading week 1 projections…"
  curl -s "https://api.sleeper.app/projections/nfl/$SEASON/1?season_type=regular&order_by=pts_half_ppr&$POS" \
    -o "$DIR/week1.json"
fi

# Grab a real league's settings too, so the tests run against genuine 147-rule
# scoring rather than only the built-in defaults.
if [ ! -f "$DIR/league.json" ]; then
  echo "downloading a real league config…"
  python3 - "$DIR" "$SEASON" <<'PYEOF'
import json, sys, urllib.request
d, season = sys.argv[1], sys.argv[2]
def get(u): return json.load(urllib.request.urlopen(u))
try:
    uid = get("https://api.sleeper.app/v1/user/TheHadly")["user_id"]
    lgs = get("https://api.sleeper.app/v1/user/%s/leagues/nfl/%s" % (uid, season))
    if lgs:
        lg = get("https://api.sleeper.app/v1/league/%s" % lgs[0]["league_id"])
        json.dump(lg, open(d + "/league.json", "w"))
        print("  got %r (%d teams, %d scoring rules)" % (lg["name"].strip(),
              lg["total_rosters"], len(lg["scoring_settings"])))
except Exception as e:
    print("  skipped (%s) — league tests will be skipped" % e)
PYEOF
fi

exec "$JSC" test.js
