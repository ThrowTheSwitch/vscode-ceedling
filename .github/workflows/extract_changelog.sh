#!/usr/bin/env bash
# Extracts one version's section from CHANGELOG.md's "# [VERSION]" headings.
# Prints the section to stdout and exits 0 when found.
# Exits 1 when the file is missing, the heading is absent, or the section is empty.
# Callers should treat exit 1 as a signal to fall back to auto-generated release notes.
#
# Usage:
#   extract_changelog.sh <semver core> <changelog path>
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

# Trims trailing blank lines and separator rules left at the end of the section.
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
