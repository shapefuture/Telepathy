from __future__ import annotations

import pytest

from telepathy.domain.classify import Intent, Route, classify_rules, route_for


@pytest.mark.parametrize(
    "text",
    [
        "Can anyone recommend an accountant for a startup?",
        "Посоветуйте юриста по визам?",
        "Кто-нибудь знает хорошего стоматолога?",
    ],
)
def test_help_requests(text):
    c = classify_rules(text)
    assert c.intent is Intent.HELP_REQUEST and c.route is Route.PRIVATE_SUGGESTION


def test_offer_and_social():
    assert classify_rules("Могу помочь с налогами, пишите в лс").intent is Intent.HELP_OFFER
    assert classify_rules("Всем привет!").intent is Intent.SOCIAL


def test_bare_question_goes_to_review_not_promotion():
    c = classify_rules("what time is it?")
    assert c.route is Route.REVIEW


@pytest.mark.parametrize(
    "p,route",
    [
        (0.8, Route.PRIVATE_SUGGESTION),
        (0.79, Route.REVIEW),
        (0.5, Route.REVIEW),
        (0.49, Route.DISCARD),
        (float("nan"), Route.DISCARD),
        (1.5, Route.DISCARD),
    ],
)
def test_thresholds(p, route):
    assert route_for(p) is route
