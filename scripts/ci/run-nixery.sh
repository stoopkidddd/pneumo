#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -sm)" == "Linux x86_64" && -d /nix/store ]]; then
  # npm executables expect the FHS loader; Nix binaries encode a store path instead.
  runtime=$(command -v node || command -v bash)
  runtime=$(readlink -f "$runtime")
  loader=$(patchelf --print-interpreter "$runtime")
  if [[ ! -e /lib64/ld-linux-x86-64.so.2 ]]; then
    mkdir -p /lib64
    ln -s "$loader" /lib64/ld-linux-x86-64.so.2
  fi
  # Keep store paths: custom-registry libraries need not be linked into /lib.
  libraries=$(patchelf --print-rpath "$runtime")
  for directory in /nix/store/*-gcc-*-lib/lib; do
    if [[ -f "$directory/libgcc_s.so.1" ]]; then
      libraries="${libraries:+$libraries:}$directory"
    fi
  done
  LD_LIBRARY_PATH="$(dirname "$loader")${libraries:+:$libraries}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH
fi

if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

exec "$@"
