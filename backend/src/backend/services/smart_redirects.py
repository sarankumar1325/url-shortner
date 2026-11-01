"""Smart redirects: send visitors to another destination by device or country."""

from collections.abc import Callable

from backend.core.problems import APIError
from backend.services.analytics import visitor_traits

MAX_RULES = 10
MAX_COUNTRIES = 50
DEVICES = ("ios", "android", "mobile", "tablet", "desktop")


def _invalid(field: str, message: str, code: str = "invalid") -> APIError:
    return APIError(
        422,
        "validation_error",
        message,
        errors=[{"field": field, "code": code, "message": message}],
    )


def _strings(value: object, field: str, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise _invalid(field, f"{label} must be a list of strings.")
    return value


def validate_rules(
    rules: list[dict] | None, validate_url: Callable[[str], str]
) -> list[dict] | None:
    """Normalize rules for storage; an empty list means no rules (None).

    Every rule needs at least one condition and a destination that passes the
    same checks as the main destination.
    """
    if not rules:
        return None
    if len(rules) > MAX_RULES:
        raise _invalid("redirect_rules", f"Use at most {MAX_RULES} redirect rules.", "too_many")
    cleaned: list[dict] = []
    for index, rule in enumerate(rules):
        prefix = f"redirect_rules.{index}"
        label = f"Rule {index + 1}"
        devices = _strings(rule.get("devices"), f"{prefix}.devices", f"{label}: devices")
        unknown = sorted({device for device in devices if device not in DEVICES})
        if unknown:
            raise _invalid(
                f"{prefix}.devices",
                f"{label}: unknown device {unknown[0]!r}. Use {', '.join(DEVICES)}.",
            )
        countries = [
            country.strip().upper()
            for country in _strings(rule.get("countries"), f"{prefix}.countries", label)
        ]
        bad = next((c for c in countries if len(c) != 2 or not (c.isascii() and c.isalpha())), None)
        if bad is not None:
            raise _invalid(
                f"{prefix}.countries",
                f"{label}: {bad!r} is not a two-letter country code.",
            )
        countries = sorted(set(countries))
        if len(countries) > MAX_COUNTRIES:
            raise _invalid(
                f"{prefix}.countries", f"{label}: use at most {MAX_COUNTRIES} countries."
            )
        if not devices and not countries:
            raise _invalid(
                prefix, f"{label}: choose at least one device or country.", "missing_condition"
            )
        url = rule.get("url")
        if not isinstance(url, str):
            raise _invalid(f"{prefix}.url", f"{label}: add a destination URL.")
        try:
            url = validate_url(url)
        except APIError as exc:
            raise _invalid(f"{prefix}.url", f"{label}: {exc.detail}", exc.code) from None
        item: dict = {"url": url}
        if devices:
            item["devices"] = [device for device in DEVICES if device in devices]
        if countries:
            item["countries"] = countries
        cleaned.append(item)
    return cleaned


def matches(rule: dict, traits: frozenset[str], country: str | None) -> bool:
    """Every condition a rule sets must match; within one, any value matches."""
    devices = rule.get("devices")
    if devices and not traits.intersection(devices):
        return False
    countries = rule.get("countries")
    if countries and country not in countries:
        return False
    return True


def pick(rules: list[dict], user_agent: str | None, country: str | None) -> str | None:
    traits, iso = visitor_traits(user_agent, country)
    for rule in rules:
        if matches(rule, traits, iso):
            return rule["url"]
    return None
