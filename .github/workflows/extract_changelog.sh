#!/usr/bin/env bash
# Extracts one version's section out of a Keep-a-Changelog-style "# [VERSION] ..." changelog
# (this project's CHANGELOG.md uses H1, not H2, version headings) for use as a GitHub
# Release body. Adapted directly from Ceedling's own .github/workflows/extract_changelog.sh.
# Standalone and parameter-driven (no GitHub Actions context read internally), so it's
# runnable/testable directly from a terminal:
#
#   .github/workflows/extract_changelog.sh 2.0.0 CHANGELOG.md
#
# A prerelease tag and its eventual final-release tag share one changelog section - pass the
# caller-stripped semver core (e.g. "2.0.0" for both "v2.0.0" and "v2.0.0-pre.1") either way.
#
# Prints the extracted section to stdout and exits 0 when the version's heading is found with a
# non-empty body; exits 1 (nothing printed but an explanation on stderr) when the changelog file
# is missing, the heading isn't present, or the heading's section is empty - callers should treat
# exit 1 as "fall back to GitHub's auto-generated release notes", not as a hard failure.
set -euo pipefail

SEMVER_CORE="${1:?usage: extract_changelog.sh <semver-core> <changelog-path>}"
CHANGELOG="${2:?usage: extract_changelog.sh <semver-core> <changelog-path>}"

if [ ! -f "$CHANGELOG" ]; then
    echo "error: changelog file not found: ${CHANGELOG}" >&2
    exit 1
fi

LINES=()
while IFS= read -r line || [ -n "$line" ]; do
    LINES+=("$line")
done < <(awk -v ver="$SEMVER_CORE" '
    BEGIN { gsub(/\./, "\\.", ver); pat = "^# \\[" ver "\\]" }
    $0 ~ pat          { found=1; next }
    found && /^# \[/  { exit }
    found             { print }
' "$CHANGELOG")

is_blank() { [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; }
is_separator() { [[ "$1" =~ ^[[:space:]]*(---|\<br/?\>)[[:space:]]*$ ]]; }

# Trim trailing blank lines and separator rules (the horizontal rule that precedes the next
# version heading) left over at the tail of the extracted section.
count=${#LINES[@]}
while [ "$count" -gt 0 ]; do
    last="${LINES[$((count - 1))]}"
    if is_blank "$last" || is_separator "$last"; then
        count=$((count - 1))
    else
        break
    fi
done

if [ "$count" -eq 0 ]; then
    echo "error: no non-empty section found for version '${SEMVER_CORE}' in ${CHANGELOG}" >&2
    exit 1
fi

printf '%s\n' "${LINES[@]:0:count}"
