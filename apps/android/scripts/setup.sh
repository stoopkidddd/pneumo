#!/bin/sh
set -eu

: "${ANDROID_HOME:?Run through mise so ANDROID_HOME is set}"
if [ ! -d "$ANDROID_HOME" ]; then
    printf 'Android SDK not found at %s. See apps/android/README.md.\n' "$ANDROID_HOME" >&2
    exit 1
fi

# Managed-device image lookup requires the same physical root as the SDK package index.
sdk_dir=$(CDPATH= cd "$ANDROID_HOME" && pwd -P)

# Java properties escape backslashes, colons and spaces in SDK paths.
sdk_dir=$(printf '%s' "$sdk_dir" | sed 's/\\/\\\\/g; s/:/\\:/g; s/ /\\ /g')
printf 'sdk.dir=%s\n' "$sdk_dir" > local.properties
printf 'Android local.properties ready.\n'
