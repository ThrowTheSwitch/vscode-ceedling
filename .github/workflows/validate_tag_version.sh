#!/usr/bin/env bash
# Confirms a pushed git tag names the same version as package.json's committed "version" field -
# the source of truth `vsce package`/`publish` actually reads. Fails loudly on any mismatch,
# before packaging or publishing anything. Standalone and parameter-driven (no GitHub Actions
# context read internally), so it's runnable/testable directly from a terminal:
#
#   .github/workflows/validate_tag_version.sh v2.0.0 package.json         # -> exit 0
#   .github/workflows/validate_tag_version.sh v2.0.0-pre.1 package.json   # -> exit 0 (matches core)
#   .github/workflows/validate_tag_version.sh v9.9.9 package.json        # -> exit 1
set -euo pipefail

TAG="${1:?usage: validate_tag_version.sh <tag> <package.json path>}"
PACKAGE_JSON="${2:?usage: validate_tag_version.sh <tag> <package.json path>}"

# Strip the leading "v" and any -pre.N/-beta.N/-alpha.N prerelease suffix, leaving the semver
# core - a prerelease tag and its eventual final-release tag are both expected to name the same
# package.json version (the version being iterated toward, not yet-incremented for each prerelease).
TAG_VERSION="${TAG#v}"
TAG_VERSION="${TAG_VERSION%%-*}"

PACKAGE_VERSION="$(node -p "require('$(realpath "$PACKAGE_JSON")').version")"

if [ "$TAG_VERSION" != "$PACKAGE_VERSION" ]; then
    echo "error: tag '${TAG}' names version '${TAG_VERSION}', but ${PACKAGE_JSON} has version '${PACKAGE_VERSION}'." >&2
    echo "Bump \"version\" in ${PACKAGE_JSON} to match (in a commit, before tagging) and push a new tag." >&2
    exit 1
fi

echo "tag '${TAG}' matches ${PACKAGE_JSON} version '${PACKAGE_VERSION}'"
