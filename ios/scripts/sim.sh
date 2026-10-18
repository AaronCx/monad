#!/bin/bash
# sim.sh [DEVICE_TYPE_NAME]: print the UDID of a simulator named "Monad <device>
# (<iOS>)" on the newest installed iOS runtime, creating it if needed. Runner
# images ship runtimes without a matching named device, so destinations by
# name alone are not reliable.
set -euo pipefail
DEVICE="${1:-iPhone 17}"
read -r RUNTIME VERSION < <(xcrun simctl list runtimes -j | python3 -c '
import json, sys
rs = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
rs.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
print(rs[-1]["identifier"], rs[-1]["version"]) if rs else sys.exit("no iOS simulator runtime installed")
')
NAME="Monad $DEVICE ($VERSION)"
UDID=$(xcrun simctl list devices -j | python3 -c '
import json, sys
for d in json.load(sys.stdin)["devices"].get(sys.argv[2], []):
    if d["name"] == sys.argv[1] and d.get("isAvailable"):
        print(d["udid"]); break
' "$NAME" "$RUNTIME")
if [[ -z "$UDID" ]]; then
  TYPE=$(xcrun simctl list devicetypes -j | python3 -c '
import json, sys
for t in json.load(sys.stdin)["devicetypes"]:
    if t["name"] == sys.argv[1]:
        print(t["identifier"]); break
else:
    sys.exit(f"no simulator device type named {sys.argv[1]!r}")
' "$DEVICE")
  UDID=$(xcrun simctl create "$NAME" "$TYPE" "$RUNTIME")
fi
echo "$UDID"
