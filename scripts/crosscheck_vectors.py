#!/usr/bin/env python3
"""Cross-check the non-AES portions of the Pneumo crypto vectors with stdlib only."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any, NoReturn


def decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hkdf_sha256(master_key: bytes, label: str, length: int) -> bytes:
    # RFC 5869: omitted/empty salt is HashLen zero bytes.
    pseudorandom_key = hmac.digest(bytes(32), master_key, "sha256")
    output = bytearray()
    previous = b""
    counter = 1
    info = label.encode("utf-8")
    while len(output) < length:
        previous = hmac.digest(
            pseudorandom_key, previous + info + bytes((counter,)), "sha256"
        )
        output.extend(previous)
        counter += 1
    return bytes(output[:length])


def mismatch(section: str, name: str) -> NoReturn:
    print(f"{section}:{name}: mismatch", file=sys.stderr)
    raise SystemExit(1)


def crosscheck(vectors: dict[str, Any]) -> None:
    for case in vectors["kdf"]:
        passphrase = unicodedata.normalize("NFC", case["passphrase"]).encode("utf-8")
        params = case["params"]
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            passphrase,
            decode(params["salt"]),
            params["iterations"],
            dklen=32,
        )
        if not hmac.compare_digest(actual, decode(case["masterKey"])):
            mismatch("kdf", case["name"])

    for case in vectors["hkdf"]:
        actual = hkdf_sha256(
            decode(case["masterKey"]), case["label"], case["length"]
        )
        if not hmac.compare_digest(actual, decode(case["output"])):
            mismatch("hkdf", case["name"])

    for case in vectors["keyCheck"]:
        check_key = hkdf_sha256(
            decode(case["masterKey"]), "pneumo/v1/check", 32
        )
        actual = hmac.digest(check_key, b"pneumo/v1/key-check", "sha256")
        if not hmac.compare_digest(actual, decode(case["output"])):
            mismatch("keyCheck", case["name"])

    for case in vectors["authKey"]:
        actual = hkdf_sha256(decode(case["masterKey"]), "pneumo/v1/auth", 32)
        if not hmac.compare_digest(actual, decode(case["output"])):
            mismatch("authKey", case["name"])


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: crosscheck_vectors.py VECTORS", file=sys.stderr)
        return 2
    try:
        with Path(sys.argv[1]).open("r", encoding="utf-8") as source:
            vectors = json.load(source)
        crosscheck(vectors)
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError):
        print("vector cross-check input error", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
