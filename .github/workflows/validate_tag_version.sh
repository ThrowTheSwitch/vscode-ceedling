#!/usr/bin/env bash
# Confirms a git tag names the same version as package.json.
# Exits 1 on any mismatch.
#
# Usage:
#   validate_tag_version.sh <tag> <package.json path>
set -euo pipefail

TAG="${1:?usage: validate_tag_version.sh <tag> <package.json path>}"
PACKAGE_JSON="${2:?usage: validate_tag_version.sh <tag> <package.json path>}"

# Strips the leading "v" and any prerelease suffix, leaving the semver core.
TAG_VERSION="${TAG#v}"
TAG_VERSION="${TAG_VERSION%%-*}"

PACKAGE_VERSION="$(node -p "require('$(realpath "$PACKAGE_JSON")').version")"

if [ "$TAG_VERSION" != "$PACKAGE_VERSION" ]; then
    echo "error: tag '${TAG}' names version '${TAG_VERSION}', but ${PACKAGE_JSON} has version '${PACKAGE_VERSION}'." >&2
    echo "Bump \"version\" in ${PACKAGE_JSON} to match, then push a new tag." >&2
    exit 1
fi

echo "tag '${TAG}' matches ${PACKAGE_JSON} version '${PACKAGE_VERSION}'"
