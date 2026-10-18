"""
BASE58 IN THE BACKSTOP: a Solana id is refused wherever an 0x one is.

Three groups. The detector gives the same answers as packages/core/src/ids.ts,
case for case, from a fixture both languages read. `_reject_executable` refuses
a Solana key, signature or explorer link in every field it already screened,
model output and desk-policy input alike. And everything it accepted before
that carries no Solana id is accepted still, with every EVM refusal in its old
words.

No model is called and nothing leaves the process.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from brain.onchain_ids import base58_decode, onchain_id_in, onchain_ids_in
from brain.schemas import BrainDecision, Cost, DeskAnalysis, Evidence

from test_prompt_snapshot import pulse_memecoin

CASES = json.loads((Path(__file__).resolve().parent / "data" / "onchain_ids.json").read_text(encoding="utf-8"))["cases"]

MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"
SYSTEM_PROGRAM = "1" * 32
SIG = "3NGW7mkqWR84fuKhxiUmVTJg8AehpcEQHKZcivruB5449akQiFvm2Ej6AvJGLnfwW15Cb2wn1D6UAFMJtXh6tigd"
#: The 64-byte keypair of the all-0x05 test seed: a secret key is a signature's length.
KEYPAIR = "6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbpoz75fGXT3N41QtwPtrdu4wMT1tyRu2125Uyu92AnxEC"
#: A real ed25519 public key with no digits (ids.test.ts pins its test seed).
LETTERS_32 = "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT"
LETTERS_64 = "A" * 87


# ── the detector ───────────────────────────────────────────────────────────


def test_the_shared_cases_are_there():
    # An empty list would parametrize into one skip, and a skip is green.
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40] or "empty")
def test_the_detector_answers_as_ids_ts_does(case):
    got = [h._asdict() for h in onchain_ids_in(case["text"])]
    assert got == case["hits"]
    assert onchain_id_in(case["text"]) is bool(case["hits"])


def test_base58_decodes_lengths_and_leading_zeros():
    assert base58_decode(SYSTEM_PROGRAM) == bytes(32)
    assert len(base58_decode(MINT)) == 32
    assert len(base58_decode(SIG)) == 64 and len(base58_decode(KEYPAIR)) == 64
    assert base58_decode("1") == b"\x00" and base58_decode("2") == b"\x01" and base58_decode("21") == b"\x3a"
    assert len(base58_decode(LETTERS_32)) == 32 and len(base58_decode(LETTERS_64)) == 64


@pytest.mark.parametrize("s", ["0abc", "Oabc", "Iabc", "labc", "", "a b", "z" * 129])
def test_base58_refuses_what_is_not_base58(s):
    assert base58_decode(s) is None


def test_anything_but_text_is_no_hit():
    assert onchain_ids_in(None) == [] and onchain_ids_in(42) == [] and onchain_ids_in(["x"]) == []


# ── the backstop ───────────────────────────────────────────────────────────


def _decision(**over) -> dict:
    base = dict(
        decision_id="dec_1", agent_id="agent-a", created_at=1, action="hold", instrument_id="merrymen:meme",
        symbol="MEME", confidence=0.5, suggested_delta_usdg=0, thesis="Buys are thinning into strength.",
        tier="pulse", cost=Cost(model_calls=0, tokens_in=0, tokens_out=0, usd=0.0),
    )
    return {**base, **over}


SOLANA_POISON = [
    (f"the mint {MINT} just migrated", "Solana address-shaped"),
    (f"sig {SIG} landed", "Solana signature- or key-shaped"),
    (f"exported {KEYPAIR}", "Solana signature- or key-shaped"),
    (f"owned by {SYSTEM_PROGRAM}", "Solana address-shaped"),
    ("see solscan.io/token/ for the chart", "Solana explorer link"),
    (f"owned by {LETTERS_32}", "Solana address-shaped"),
    (f"signature {LETTERS_64}", "Solana signature- or key-shaped"),
]


@pytest.mark.parametrize("text,why", SOLANA_POISON)
@pytest.mark.parametrize("field", ["instrument_id", "symbol", "thesis", "bull_case", "bear_case", "time_horizon"])
def test_a_decision_carrying_a_solana_id_is_refused(field, text, why):
    with pytest.raises(ValidationError, match=why) as e:
        BrainDecision(**_decision(**{field: text}))
    msg = e.value.errors()[0]["msg"]
    for word in text.split():
        assert len(word) < 32 or word not in msg, "the message names the shape, never the id"


@pytest.mark.parametrize("text,why", SOLANA_POISON)
def test_lists_and_evidence_are_screened_too(text, why):
    for field in ("risks", "invalidation"):
        with pytest.raises(ValidationError, match=why):
            BrainDecision(**_decision(**{field: ["fine", text]}))
    for field in ("source", "ref", "claim"):
        with pytest.raises(ValidationError, match=why):
            Evidence(**dict({"source": "s", "ref": "r", "claim": "c"}, **{field: text}))


@pytest.mark.parametrize("text,why", SOLANA_POISON)
def test_a_desk_read_carrying_a_solana_id_is_refused(text, why):
    good = dict(
        read="price is holding above the 0.0041 level after a 12% push, but volume has faded.",
        stance="cautious", watch="whether 0.0041 holds", invalidation="an hourly close under 0.0036",
        confidence=0.6,
    )
    DeskAnalysis(**good)
    for field in ("read", "watch", "invalidation"):
        with pytest.raises(ValidationError):
            DeskAnalysis(**dict(good, **{field: good[field] + " " + text}))


def test_the_desk_policy_cannot_carry_a_solana_id():
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via {MINT}.")
    with pytest.raises(ValidationError, match="Solana signature"):
        pulse_memecoin(strategy_terms=f"Replay {SIG}.")
    # 32 ones is a phrase by the horizon's alphabet and a key by its shape.
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(horizon=SYSTEM_PROGRAM)
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via {LETTERS_32}.")
    with pytest.raises(ValidationError, match="Solana signature"):
        pulse_memecoin(strategy_terms=f"Replay {LETTERS_64}.")


# ── what stays as it was ───────────────────────────────────────────────────


@pytest.mark.parametrize("text", [
    "PEPE pumped 40% on the week; 41 buys / 22 sells from 37 distinct buyers.",
    "Held MEME for 20 minutes; exited flat after volume faded.",
    "[ref:d3fa91cr2c1] reports two tracked wallets added",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "supercalifragilisticexpialidociousandmorewordsjoined",
])
def test_prose_and_todays_ids_still_pass(text):
    d = BrainDecision(**_decision(thesis=text, risks=[text], evidence=[Evidence(source="s", ref=text, claim=text)]))
    assert d.thesis == text
    assert pulse_memecoin(strategy_terms=text).strategy_terms == text


@pytest.mark.parametrize("text,why", [
    ("route via 0x" + "ab" * 20, "contains an address-shaped string"),
    ("calldata 0xdeadbeefcafebabe00", "contains a hex blob that could be calldata"),
    # An EVM refusal keeps its words even beside a Solana id.
    (f"0x{'ab' * 20} and {MINT}", "contains an address-shaped string"),
])
def test_every_evm_refusal_keeps_its_words(text, why):
    with pytest.raises(ValidationError) as e:
        BrainDecision(**_decision(thesis=text))
    msg = e.value.errors()[0]["msg"]
    assert msg.startswith(f"Value error, field {why}"), msg
    assert "Solana" not in msg
