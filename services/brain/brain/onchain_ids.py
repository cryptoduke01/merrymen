"""
ON-CHAIN IDS IN TEXT, by shape (Solana integration, phase 0, 2026-10-16).

The detector from packages/core/src/ids.ts (`onchainIdsIn`), mirrored here
because Brain cannot import TypeScript. The address backstop in schemas.py
caught only 0x hex, and a Solana id is base58: a model that can write a mint
or a signature can write one nobody allowlisted, exactly as with an 0x string.

THE SAME RULES, pattern for pattern:

  EVM      0x + 40 hex (an address) or 0x + 64 hex (a hash), not inside more hex.
  Solana   a base58 run, not inside a longer word, that decodes to 32 bytes
           (a key: a wallet, a mint, a program) or 64 bytes (a signature, or
           a secret key, which is the same length); and links to the Solana
           explorers.

A run made only of letters is prose, not a key: real keys and signatures carry
digits, so a run without one is never flagged. The shape is enough; a match is
never checked against a chain. tests/data/onchain_ids.json pins this file and
ids.ts to the same answers, on both sides.

Pure and self-contained: no I/O, no dependency.
"""

from __future__ import annotations

import re
from typing import Literal, NamedTuple

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58)}


def base58_decode(s: str) -> bytes | None:
    """Bitcoin-alphabet base58 to bytes, or None for any character outside it."""
    if not isinstance(s, str) or not s or len(s) > 128:
        return None
    n = 0
    for ch in s:
        digit = _B58_INDEX.get(ch)
        if digit is None:
            return None
        n = n * 58 + digit
    # Each leading "1" is a leading zero byte.
    zeros = len(s) - len(s.lstrip("1"))
    return b"\x00" * zeros + n.to_bytes((n.bit_length() + 7) // 8, "big")


class OnchainIdHit(NamedTuple):
    family: Literal["evm", "solana"]
    #: "address" (a 20- or 32-byte id), "hash" (a 32-byte EVM hash or a 64-byte
    #: Solana signature) or "link" (an explorer URL).
    shape: Literal["address", "hash", "link"]
    value: str


_EVM_IN_TEXT = re.compile(r"0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
#: A run of base58 long enough to be a 32-byte key (32-44 chars) or a 64-byte
#: signature (86-88 chars), not inside a longer word.
_BASE58_IN_TEXT = re.compile(r"(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![0-9A-Za-z])")
#: JavaScript's `\s`, spelled out, so a link ends where ids.ts ends it. ASCII
#: below keeps `\b` and the case folding to ASCII letters, as JavaScript does.
_JS_SPACE = "\t\n\v\f\r    -     　﻿"
_SOLANA_LINK = re.compile(
    r"\b(?:https?://)?(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanabeach\.io|orb\.helius\.dev)/"
    f"[^{_JS_SPACE})>\\]]*",
    re.IGNORECASE | re.ASCII,
)
_DIGIT = re.compile(r"[1-9]")


def onchain_ids_in(text: object) -> list[OnchainIdHit]:
    """
    Every on-chain id in a text, in ids.ts order: EVM ids, then Solana
    explorer links, then base58 runs that decode to a 32-byte key or a 64-byte
    signature.
    """
    if not isinstance(text, str) or not text:
        return []
    hits: list[OnchainIdHit] = []
    for m in _EVM_IN_TEXT.finditer(text):
        hits.append(OnchainIdHit("evm", "hash" if len(m[0]) == 66 else "address", m[0]))
    for m in _SOLANA_LINK.finditer(text):
        hits.append(OnchainIdHit("solana", "link", m[0]))
    for m in _BASE58_IN_TEXT.finditer(text):
        s = m[0]
        if not _DIGIT.search(s):
            continue
        b = base58_decode(s)
        if b is not None and len(b) == 32:
            hits.append(OnchainIdHit("solana", "address", s))
        elif b is not None and len(b) == 64:
            hits.append(OnchainIdHit("solana", "hash", s))
    return hits


def onchain_id_in(text: object) -> bool:
    """Whether a text carries any on-chain id (onchain_ids_in)."""
    return bool(onchain_ids_in(text))
