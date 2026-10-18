#!/bin/bash
# upload-testflight.sh: archive the Monad app, upload it to App Store Connect
# (app 6824323496, com.aaroncx.monad) and wait until the build is VALID.
#
# Machine-local prerequisites (Aaron's Mac mini only): full Xcode at
# /Applications/Xcode.app, the "Apple Distribution" identity in
# relay-ci.keychain with its password in ~/.appstoreconnect/relay-ci-keychain-pass,
# the "monad App Store" provisioning profile installed, the App Store Connect
# API key under ~/.appstoreconnect/private_keys with its key and issuer IDs in
# ~/.appstoreconnect/asc.env (ASC_KEY_ID=..., ASC_ISSUER_ID=...; not in this
# repo), and PyJWT for python3.
# The build number is CURRENT_PROJECT_VERSION in project.yml: bump it first.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
APP_ID=6824323496
TEAM=P6VJJ7XQN9
ASC_ENV="$HOME/.appstoreconnect/asc.env"
[[ -r "$ASC_ENV" ]] && source "$ASC_ENV"
KEY_ID="${ASC_KEY_ID:?set ASC_KEY_ID in $ASC_ENV or the environment}"
ISSUER="${ASC_ISSUER_ID:?set ASC_ISSUER_ID in $ASC_ENV or the environment}"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8"
BUILD=$(awk '/CURRENT_PROJECT_VERSION:/ {print $2; exit}' project.yml)
VERSION=$(awk '/MARKETING_VERSION:/ {gsub(/"/, "", $2); print $2; exit}' project.yml)
ARCHIVE_DIR="$HOME/Library/Developer/Xcode/Archives/Monad"
ARCHIVE="$ARCHIVE_DIR/Monad-$VERSION-$BUILD.xcarchive"
mkdir -p "$ARCHIVE_DIR"
[[ -z "$(git status --porcelain -- .)" ]] || { echo "ios/ has uncommitted changes; commit first" >&2; exit 1; }

# The password goes to security over stdin (printf is a builtin), never on
# argv where ps or an xtrace run would show it.
{ set +x; } 2>/dev/null
printf 'unlock-keychain -p "%s" relay-ci.keychain\n' "$(cat "$HOME/.appstoreconnect/relay-ci-keychain-pass")" | security -i >/dev/null
xcodegen generate --spec project.yml
xcodebuild -project Monad.xcodeproj -scheme Monad -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" archive \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" DEVELOPMENT_TEAM=$TEAM \
  PROVISIONING_PROFILE_SPECIFIER="monad App Store" OTHER_CODE_SIGN_FLAGS="--keychain relay-ci.keychain" \
  | tail -3

EXPORT_PLIST=$(mktemp -t monad-export).plist
cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>com.aaroncx.monad</key><string>monad App Store</string></dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "$ARCHIVE_DIR/export-$BUILD" \
  -authenticationKeyPath "$KEY_PATH" -authenticationKeyID $KEY_ID -authenticationKeyIssuerID $ISSUER \
  | tail -3
rm -f "$EXPORT_PLIST"

# Poll until App Store Connect has processed it. Missing after ~10 minutes
# usually means an email-only ingest rejection.
for _ in $(seq 1 40); do
  state=$(KEY_PATH="$KEY_PATH" python3 -I - "$APP_ID" "$BUILD" "$KEY_ID" "$ISSUER" <<'PY'
import json, os, subprocess, sys, tempfile, time, jwt
app, build, kid, iss = sys.argv[1:5]
now = int(time.time())
tok = jwt.encode({'iss': iss, 'iat': now, 'exp': now + 600, 'aud': 'appstoreconnect-v1'},
                 open(os.environ['KEY_PATH']).read(), algorithm='ES256', headers={'kid': kid})
fd, header = tempfile.mkstemp()
with os.fdopen(fd, 'w') as f:
    f.write('Authorization: Bearer ' + tok + '\n')
url = f'https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D={app}&filter%5Bversion%5D={build}&fields%5Bbuilds%5D=processingState'
out = subprocess.run(['curl', '-sS', '-m', '30', '-H', '@' + header, url], capture_output=True, text=True).stdout
os.unlink(header)
data = json.loads(out or '{}').get('data') or []
print(data[0]['attributes']['processingState'] if data else 'MISSING')
PY
)
  echo "build $BUILD: $state"
  [[ "$state" == VALID ]] && exit 0
  [[ "$state" == FAILED || "$state" == INVALID ]] && exit 1
  sleep 15
done
echo "build $BUILD did not become VALID in 10 minutes" >&2
exit 1
