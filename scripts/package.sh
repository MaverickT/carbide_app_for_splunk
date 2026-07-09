#!/usr/bin/env bash
#
# Build + validate the Splunkbase release package for Carbide App for Splunk.
#
#   ./scripts/package.sh              build, run AppInspect (full + cloud), emit tarball
#   ./scripts/package.sh --skip-inspect   build only (fast)
#
# Output: ../carbide_app_for_splunk-<version>.tar.gz  (repo parent dir)
#
# What it does, in order:
#   1. refuses to package a dirty working tree (the tarball is built from
#      git HEAD, so uncommitted changes would silently NOT ship)
#   2. checks version consistency: [launcher] version == [id] version
#      == app.manifest version
#   3. stages tracked files only via `git archive HEAD` (drops .claude/,
#      .DS_Store, local/, anything untracked; .gitattributes export-ignore
#      keeps scripts/ and .gitignore out)
#   4. normalizes permissions (dirs 755, files 644) and builds the tarball
#      with COPYFILE_DISABLE + --no-xattrs (no macOS ._* AppleDouble junk),
#      uid/gid 0
#   5. runs AppInspect twice - full default check set and --included-tags
#      cloud - and fails if either reports errors or failures
#      (first run bootstraps a venv in .appinspect-venv/; needs libmagic:
#       brew install libmagic)
#
set -euo pipefail

APP_ID="carbide_app_for_splunk"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(dirname "$REPO_ROOT")"
VENV="$REPO_ROOT/.appinspect-venv"
SKIP_INSPECT=0
[ "${1:-}" = "--skip-inspect" ] && SKIP_INSPECT=1

cd "$REPO_ROOT"

# --- 1. clean tree -----------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: working tree is dirty. Commit (or stash) first - the package" >&2
    echo "is built from git HEAD, so uncommitted changes would not ship:" >&2
    git status --short >&2
    exit 1
fi

# --- 2. version consistency ---------------------------------------------------
ver_launcher=$(awk -F' = ' '/^\[launcher\]/{s=1} s&&/^version/{print $2; exit}' default/app.conf)
ver_id=$(awk -F' = '       '/^\[id\]/{s=1}       s&&/^version/{print $2; exit}' default/app.conf)
ver_manifest=$(python3 -c "import json; print(json.load(open('app.manifest'))['info']['id']['version'])")
build=$(awk -F' = ' '/^build/{print $2; exit}' default/app.conf)

if [ "$ver_launcher" != "$ver_id" ] || [ "$ver_launcher" != "$ver_manifest" ]; then
    echo "ERROR: version mismatch:" >&2
    echo "  app.conf [launcher] version = $ver_launcher" >&2
    echo "  app.conf [id] version       = $ver_id" >&2
    echo "  app.manifest version        = $ver_manifest" >&2
    exit 1
fi
VERSION="$ver_launcher"
PKG="$OUT_DIR/$APP_ID-$VERSION.tar.gz"
echo "==> $APP_ID $VERSION (build $build)"

# is_configured must ship false (Splunkbase check_that_setup_has_not_been_performed)
if ! grep -q '^is_configured = false' default/app.conf; then
    echo "ERROR: default/app.conf must ship is_configured = false" >&2
    exit 1
fi
# [triggers] may only list custom confs; we ship none at all
if grep -q '^\[triggers\]' default/app.conf; then
    echo "ERROR: default/app.conf has a [triggers] stanza (AppInspect check_for_trigger_stanza)" >&2
    exit 1
fi

# --- 3. stage tracked files ----------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git archive --format=tar --prefix="$APP_ID/" HEAD | tar -x -C "$STAGE"

# belt & braces: nothing hidden, nothing repo-only may remain
leftovers=$(find "$STAGE/$APP_ID" \( -name ".*" -o -name "*.pyc" -o -type l \) | grep -v '^\.$' || true)
if [ -n "$leftovers" ]; then
    echo "ERROR: unexpected files in stage (add them to .gitattributes export-ignore):" >&2
    echo "$leftovers" >&2
    exit 1
fi
if [ -d "$STAGE/$APP_ID/local" ]; then
    echo "ERROR: local/ is tracked in git - it must never ship" >&2
    exit 1
fi

# --- 4. tarball ----------------------------------------------------------------
find "$STAGE/$APP_ID" -type d -exec chmod 755 {} +
find "$STAGE/$APP_ID" -type f -exec chmod 644 {} +
export COPYFILE_DISABLE=1
tar -C "$STAGE" --no-xattrs --uid 0 --gid 0 --numeric-owner -czf "$PKG" "$APP_ID" 2>/dev/null \
    || tar -C "$STAGE" -czf "$PKG" "$APP_ID"
echo "==> built $PKG ($(ls -lh "$PKG" | awk '{print $5}'))"

# --- 5. AppInspect --------------------------------------------------------------
if [ "$SKIP_INSPECT" = "1" ]; then
    echo "==> AppInspect SKIPPED (--skip-inspect)"
else
    if [ ! -x "$VENV/bin/splunk-appinspect" ]; then
        echo "==> bootstrapping AppInspect venv in $VENV"
        python3 -m venv "$VENV"
        "$VENV/bin/pip" -q install --upgrade pip
        "$VENV/bin/pip" -q install splunk-appinspect
    fi
    # NB: find exits non-zero when a search dir doesn't exist; under
    # pipefail that would fail the pipeline even when grep matches.
    if ! { find /opt/homebrew/lib /usr/local/lib /usr/lib -name "libmagic*" 2>/dev/null || true; } | grep -q .; then
        echo "ERROR: libmagic not found - run: brew install libmagic" >&2
        exit 1
    fi
    fail=0
    for tags in "" "cloud"; do
        label="${tags:-full}"
        report="$OUT_DIR/appinspect_${label}_$VERSION.json"
        echo "==> AppInspect ($label)..."
        # shellcheck disable=SC2086
        "$VENV/bin/splunk-appinspect" inspect "$PKG" \
            ${tags:+--included-tags $tags} \
            --data-format json --output-file "$report" >/dev/null 2>&1 || true
        summary=$(python3 -c "
import json,sys
s = json.load(open('$report'))['summary']
print('errors=%d failures=%d warnings=%d success=%d' % (s['error'], s['failure'], s['warning'], s['success']))
sys.exit(1 if s['error'] or s['failure'] else 0)") && rc=0 || rc=1
        echo "    $label: $summary   ($report)"
        [ $rc -ne 0 ] && fail=1
    done
    if [ "$fail" = "1" ]; then
        echo "ERROR: AppInspect reported errors/failures - see the JSON reports above." >&2
        echo "Show details with:" >&2
        echo "  python3 -c \"import json;[print(c['result'],c['name'],[m['message'] for m in c['messages']]) for r in json.load(open('REPORT'))['reports'] for g in r['groups'] for c in g['checks'] if c['result'] in ('failure','error')]\"" >&2
        exit 1
    fi
fi

shasum -a 256 "$PKG"
echo "==> DONE. Upload $PKG to https://splunkbase.splunk.com"
