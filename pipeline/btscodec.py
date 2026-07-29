"""TranStats URL obfuscation.

BTS obfuscates its query strings. There are **two different ciphers** on the same page, and
confusing them is why `Table_ID=259` isn't findable by guessing:

1. **Query params** (`Z1qr_VQ`, `FIM`, `Nv4 Pn44vr45`) use ROT13 over a *36-character*
   alphabet — letters followed by digits. Because the alphabet is 36 wide, rotating by 13
   is **not** an involution: encoding and decoding are opposite directions. Letters cross
   into digits and back (`o` <-> `1`, `s` <-> `5`, `r` <-> `4`).

   Three rules, derived empirically and exact across every observed pair:

   | Input | Rule | Because |
   |---|---|---|
   | lowercase letter | 36-char alphabet | `o` -> `1`, `v` -> `8` |
   | digit | 36-char alphabet, UPPER output | `2` -> `F`, `9` -> `M` |
   | **uppercase** | **plain ROT13, lowercased if it wraps past Z** | `A` -> `N`, `T` -> `g` |

   That third rule is the subtle one. It is why `Table_ID` -> `gnoyr_VQ` and
   `Aviation Support Tables` -> `N8vn6v10 f722146 gnoyr5`.

2. **Lookup-table names** (`Y_fReiVPR_PYNff`) use ordinary ROT13 over letters only, which
   *is* self-inverse. Case in the encoded form is scrambled, so decoding is
   case-insensitive and normalises to upper.

The two agree on any letter that doesn't cross into the digit range, which is what makes
the difference easy to miss — `QO_VQ` -> `DB_ID` decodes correctly under either.

Verified against live pages 2026-07 against 10 observed pairs; see docs/data/sources.md.

.. warning::
   **Encoding is exact; decoding is ambiguous.** Lowercase `a`-`m` in an encoded string
   could have come from lowercase `x`-`z` or from wrapped uppercase `N`-`Z`.
   :func:`decode_param` resolves toward the lowercase reading — right for values
   (``FIM`` -> ``259``) but wrong for names (``gnoyr_VQ`` -> ``3able_ID``, not ``Table_ID``).

   Use :func:`decode_param` for discovery, :func:`encode_param` to build real URLs, and
   never round-trip a param name through both.
"""

from __future__ import annotations

import string

_LOWER = string.ascii_lowercase + string.digits  # 36 chars
_UPPER = string.ascii_uppercase + string.digits  # 36 chars
_ROT = 13

#: Encoded params the rules below cannot produce. Empty — every observed pair is explained.
#: If BTS ever emits something anomalous it belongs here, not worked around at a call site.
ANOMALOUS_PARAMS: dict[str, str] = {}


def encode_param(plaintext: str) -> str:
    """Plaintext -> the obfuscated form used in TranStats query strings.

    Exact for every observed pair. Prefer this over hardcoded literals so a table URL can be
    built from a readable name.

    >>> encode_param("259")
    'FIM'
    >>> encode_param("Table_ID")
    'gnoyr_VQ'
    >>> encode_param("Aviation Support Tables")
    'N8vn6v10 f722146 gnoyr5'
    """
    out = []
    for ch in plaintext:
        if "a" <= ch <= "z":
            # 36-char alphabet: lowercase letters cross into digits (o -> 1, s -> 5).
            out.append(_LOWER[(_LOWER.index(ch) + _ROT) % 36])
        elif ch.isdigit():
            # Digits rotate into UPPERCASE letters (2 -> F, 9 -> M).
            out.append(_UPPER[(_UPPER.index(ch) + _ROT) % 36])
        elif "A" <= ch <= "Z":
            # Uppercase uses plain ROT13 over 26 — NOT the 36-char alphabet — and is
            # lowercased when the rotation wraps past Z. This is the rule that made
            # `Table_ID` -> `gnoyr_VQ` look like a BTS bug for a while.
            rotated = ord(ch) - 65 + _ROT
            letter = chr(rotated % 26 + 65)
            out.append(letter.lower() if rotated >= 26 else letter)
        else:
            out.append(ch)
    return "".join(out)


def decode_param(obfuscated: str) -> str:
    """Obfuscated TranStats query-string form -> plaintext.

    >>> decode_param("FIM")
    '259'
    >>> decode_param("Z1qr_VQ")
    'Mode_ID'
    """
    out = []
    for ch in obfuscated:
        if "a" <= ch <= "z" or ch.isdigit():
            out.append(_LOWER[(_LOWER.index(ch) - _ROT) % 36])
        elif "A" <= ch <= "Z":
            out.append(_UPPER[(_UPPER.index(ch) - _ROT) % 36])
        else:
            out.append(ch)
    return "".join(out)


def _rot13_letters(text: str) -> str:
    """Ordinary ROT13 over ASCII letters only. Self-inverse."""
    out = []
    for ch in text:
        if "a" <= ch <= "z":
            out.append(chr((ord(ch) - 97 + _ROT) % 26 + 97))
        elif "A" <= ch <= "Z":
            out.append(chr((ord(ch) - 65 + _ROT) % 26 + 65))
        else:
            out.append(ch)
    return "".join(out)


def decode_lookup(obfuscated: str) -> str:
    """Obfuscated ``Download_Lookup.asp`` table name -> plaintext, normalised to upper.

    Case in the encoded form is inconsistent, so this is deliberately case-insensitive.

    >>> decode_lookup("Y_fReiVPR_PYNff")
    'L_SERVICE_CLASS'
    """
    return _rot13_letters(obfuscated.upper())


def encode_lookup(plaintext: str) -> str:
    """Plaintext lookup-table name -> the form used in ``Download_Lookup.asp`` URLs."""
    return _rot13_letters(plaintext.upper())
