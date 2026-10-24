"""Crude RU<->Latin transliteration for query expansion (P06-06).

Used only to *add* query variants ("деплой" <-> "deploy"-style spellings, "zoom" <->
"зум"), never to rewrite stored text. Precision is protected by the evidence-coverage
check in the answer layer.
"""

from __future__ import annotations

import re

_CYR = re.compile(r"[а-яё]")
_LAT = re.compile(r"[a-z]")

_RU_TO_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}  # fmt: skip

# Longest first so digraphs win.
_LAT_TO_RU = sorted(
    {
        "sch": "щ", "shch": "щ", "zh": "ж", "kh": "х", "ts": "ц", "ch": "ч", "sh": "ш",
        "yu": "ю", "ya": "я", "yo": "ё", "oo": "у", "ee": "и", "ph": "ф", "th": "т",
        "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х",
        "i": "и", "j": "дж", "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п",
        "q": "к", "r": "р", "s": "с", "t": "т", "u": "у", "v": "в", "w": "в", "x": "кс",
        "y": "й", "z": "з",
    }.items(),
    key=lambda kv: -len(kv[0]),
)  # fmt: skip


def ru_to_lat(word: str) -> str:
    return "".join(_RU_TO_LAT.get(ch, ch) for ch in word)


def lat_to_ru(word: str) -> str:
    out, i = [], 0
    vowels = "aeiou"
    while i < len(word):
        if word[i] == "y" and not word.startswith(("yu", "ya", "yo"), i):
            prev_vowel = i > 0 and word[i - 1] in vowels
            next_vowel = i + 1 < len(word) and word[i + 1] in vowels
            out.append("й" if prev_vowel or next_vowel or i == 0 else "и")
            i += 1
            continue
        for lat, ru in _LAT_TO_RU:
            if word.startswith(lat, i):
                out.append(ru)
                i += len(lat)
                break
        else:
            out.append(word[i])
            i += 1
    return "".join(out)


def variants(term: str) -> list[str]:
    """Other-script spellings of a casefolded term (excluding the term itself)."""
    if _CYR.search(term) and not _LAT.search(term):
        v = ru_to_lat(term)
    elif _LAT.search(term) and not _CYR.search(term):
        v = lat_to_ru(term)
    else:
        return []
    return [v] if v and v != term and len(v) > 2 else []
