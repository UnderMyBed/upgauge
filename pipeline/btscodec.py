"""TranStats URL obfuscation.

BTS obfuscates its query strings. There are **two different ciphers** on the same page, and
confusing them is why `Table_ID=259` isn't findable by guessing:

1. **Query params** (`Z1qr_VQ`, `FIM`, `Nv4 Pn44vr45`) use ROT13 over a *36-character*
   alphabet — letters followed by digits. Because the alphabet is 36 wide, rotating by 13
   is **not** an involution: encoding and decoding are opposite directions. Letters cross
   into digits and back (`o` <-> `1`, `s` <-> `5`, `r` <-> `4`).

   The case rule is asymmetric and was derived empirically:

   | Input | Table used | Because |
   |---|---|---|
   | lowercase letter | lower | `o` -> `1`, `v` -> `8` |
   | **digit** (encoding) | **upper** | `2` -> `F`, `9` -> `M` |
   | **digit** (decoding) | **lower** | `1` -> `o`, `5` -> `s` |
   | uppercase letter | upper | `A` -> `N`, `F` -> `2` |

2. **Lookup-table names** (`Y_fReiVPR_PYNff`) use ordinary ROT13 over letters only, which
   *is* self-inverse. Case in the encoded form is scrambled, so decoding is
   case-insensitive and normalises to upper.

The two agree on any letter that doesn't cross into the digit range, which is what makes
the difference easy to miss — `QO_VQ` -> `DB_ID` decodes correctly under either.

Verified against live pages 2026-07 against 10 observed pairs; see docs/data/sources.md.

.. warning::
   **BTS is itself inconsistent.** `gnoyr_VQ` is the param name for `Table_ID`, but it
   decodes to ``3able_ID`` — the `T` was encoded as plain-ROT13 `g` rather than 36-cipher
   `6`. Every other observed pair follows the rules above. Do not "fix" the codec to
   accommodate it; use the literal string. See ``ANOMALOUS_PARAMS``.
"""

from __future__ import annotations

import string

_LOWER = string.ascii_lowercase + string.digits  # 36 chars
_UPPER = string.ascii_uppercase + string.digits  # 36 chars
_ROT = 13

#: Encoded param names BTS produced inconsistently. Use the literal, don't round-trip it.
ANOMALOUS_PARAMS = {
    "gnoyr_VQ": "Table_ID",  # decodes to "3able_ID" under the documented rules
}


def encode_param(plaintext: str) -> str:
    """Plaintext -> the obfuscated form used in TranStats query strings.

    >>> encode_param("259")
    'FIM'
    >>> encode_param("Aviation")
    'N8vn6v10'
    """
    out = []
    for ch in plaintext:
        if "a" <= ch <= "z":
            out.append(_LOWER[(_LOWER.index(ch) + _ROT) % 36])
        elif "A" <= ch <= "Z" or ch.isdigit():
            out.append(_UPPER[(_UPPER.index(ch) + _ROT) % 36])
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
