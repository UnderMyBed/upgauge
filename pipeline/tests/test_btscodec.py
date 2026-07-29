"""Tests for the TranStats codecs.

Every pair below was observed on a live BTS page during the phase-0 spike (2026-07-29), not
constructed. That's the point — the cipher was reverse-engineered from real URLs, so these
tests *are* the evidence for the rules in btscodec's docstring.
"""

import pytest

from pipeline.btscodec import (
    ANOMALOUS_PARAMS,
    decode_lookup,
    decode_param,
    encode_lookup,
    encode_param,
)

# (obfuscated, plaintext) lifted from live transtats.bts.gov URLs.
OBSERVED_PARAMS = [
    # param names
    ("Z1qr_VQ", "Mode_ID"),
    ("Z1qr_Qr5p", "Mode_Desc"),
    ("QO_VQ", "DB_ID"),
    # param values
    ("N8vn6v10", "Aviation"),
    ("Nv4 Pn44vr45", "Air Carriers"),
    ("FIM", "259"),  # Table_ID: T-100 Domestic Segment (U.S. Carriers)  <- the one we need
    ("FIL", "258"),  # Table_ID: T-100 Domestic Market (U.S. Carriers)
    ("GEE", "311"),  # Table_ID: T-100 Domestic Segment (All Carriers)
    ("EED", "110"),  # DB_ID: Air Carrier Statistics, U.S. Carriers
    ("IMI", "595"),  # DB_ID: Aviation Support Tables
]


@pytest.mark.parametrize(("obfuscated", "plaintext"), OBSERVED_PARAMS)
def test_decode_param(obfuscated, plaintext):
    assert decode_param(obfuscated) == plaintext


@pytest.mark.parametrize(("obfuscated", "plaintext"), OBSERVED_PARAMS)
def test_encode_param(obfuscated, plaintext):
    assert encode_param(plaintext) == obfuscated


@pytest.mark.parametrize(("obfuscated", "_plaintext"), OBSERVED_PARAMS)
def test_param_roundtrip(obfuscated, _plaintext):
    assert encode_param(decode_param(obfuscated)) == obfuscated


def test_param_cipher_is_not_an_involution():
    """The 36-char alphabet means rot-13 is not self-inverse, unlike ordinary ROT13.

    If someone "simplifies" encode/decode into one shared rot() call, this fails.
    """
    assert encode_param(encode_param("259")) != "259"
    assert decode_param(encode_param("259")) == "259"


def test_letters_cross_into_digits():
    """`o`<->`1`, `s`<->`5`, `r`<->`4` — behaviour plain ROT13 does not have."""
    assert encode_param("o") == "1"
    assert encode_param("s") == "5"
    assert encode_param("r") == "4"
    assert decode_param("1") == "o"


def test_digit_case_rule_is_asymmetric():
    """Encoding a digit yields UPPER; decoding a digit yields lower.

    Derived empirically: `259` -> `FIM` (upper) but `Z1qr_VQ` -> `Mode_ID` (lower `o`).
    Getting this backwards was the original bug — it silently breaks Table_ID lookup.
    """
    assert encode_param("2") == "F"
    assert decode_param("1") == "o"
    assert encode_param("259") == "FIM"
    assert decode_param("Z1qr_VQ") == "Mode_ID"


def test_uppercase_letters_lowercase_when_the_rotation_wraps():
    """The third rule, and the one that made `gnoyr_VQ` look like a BTS bug.

    Uppercase letters use plain ROT13 (mod 26), NOT the 36-char alphabet — and the result
    is lowercased when the rotation wraps past Z. So `T` -> `g`, not `6`.
    """
    assert encode_param("A") == "N"  # no wrap, stays upper
    assert encode_param("M") == "Z"  # no wrap, stays upper
    assert encode_param("N") == "a"  # wraps -> lowercased
    assert encode_param("S") == "f"
    assert encode_param("T") == "g"
    assert encode_param("Z") == "m"


def test_table_id_param_encodes_exactly():
    """Previously believed to be a BTS encoder bug. It is not — the rule above explains it."""
    assert encode_param("Table_ID") == "gnoyr_VQ"


def test_the_aviation_support_tables_subject_encodes_exactly():
    """Load-bearing: without the right subject param BTS bounces to its homepage."""
    assert encode_param("Aviation Support Tables") == "N8vn6v10 f722146 gnoyr5"


def test_there_are_no_known_anomalies_left():
    """Kept as a tripwire: if BTS ever does emit something the rules can't produce, it
    belongs here rather than being worked around at the call site."""
    assert ANOMALOUS_PARAMS == {}


def test_decoding_is_ambiguous_for_wrapped_uppercase():
    """Encoding is exact; decoding is not, and callers must not assume otherwise.

    Lowercase `a`-`m` in an encoded string could have come from lowercase `x`-`z` or from
    wrapped uppercase `N`-`Z`. `decode_param` resolves toward the lowercase reading, which
    is right for values (`FIM` -> `259`) but wrong for names like `gnoyr_VQ`. Discovery only
    — never round-trip through it.
    """
    assert decode_param(encode_param("259")) == "259"  # values round-trip
    assert decode_param("gnoyr_VQ") != "Table_ID"  # names may not


# Lookup-table names use a *different* cipher: ordinary ROT13, letters only.
OBSERVED_LOOKUPS = [
    ("Y_fReiVPR_PYNff", "L_SERVICE_CLASS"),
    ("Y_NVePeNSg_PbaSVT", "L_AIRCRAFT_CONFIG"),
    ("Y_NVePeNSg_glcR", "L_AIRCRAFT_TYPE"),
    ("Y_haVdhR_PNeeVRef", "L_UNIQUE_CARRIERS"),
    ("Y_NVecbeg_VQ", "L_AIRPORT_ID"),
    ("Y_NVecbeg_fRd_VQ", "L_AIRPORT_SEQ_ID"),
    ("Y_PVgl_ZNeXRg_VQ", "L_CITY_MARKET_ID"),
]


@pytest.mark.parametrize(("obfuscated", "plaintext"), OBSERVED_LOOKUPS)
def test_decode_lookup(obfuscated, plaintext):
    assert decode_lookup(obfuscated) == plaintext


@pytest.mark.parametrize(("obfuscated", "plaintext"), OBSERVED_LOOKUPS)
def test_encode_lookup(obfuscated, plaintext):
    assert encode_lookup(plaintext) == obfuscated.upper()


def test_lookup_cipher_is_an_involution():
    """Unlike the param cipher, ordinary ROT13 IS self-inverse."""
    assert encode_lookup(decode_lookup("Y_fReiVPR_PYNff")) == "Y_FREIVPR_PYNFF"


def test_lookup_decoding_is_case_insensitive():
    """BTS emits inconsistent case in encoded lookup names; both must decode."""
    assert decode_lookup("Y_fReiVPR_PYNff") == decode_lookup("Y_FREIVPR_PYNFF")


def test_the_two_ciphers_agree_on_letters_but_diverge_on_digit_crossings():
    """Why the difference is easy to miss — and why both functions must exist."""
    # No digit crossing: both ciphers agree.
    assert decode_param("QO_VQ") == decode_lookup("QO_VQ") == "DB_ID"
    # Digit crossing: they diverge, and only decode_param is right for query params.
    assert decode_param("N8vn6v10") == "Aviation"
    assert decode_lookup("N8vn6v10") != "AVIATION"
