"""Resolve query boundaries before requesting FIRMS UTC calendar days."""

import re
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

ISO_DATETIME = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?"
)
MAX_UTC_DAYS = 31


def timezone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name if name is not None else "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, "Use an IANA timezone such as Europe/Amsterdam.") from None


def instant(value: str, zone: ZoneInfo, zone_given: bool) -> datetime:
    if not ISO_DATETIME.fullmatch(value):
        raise HTTPException(422, "Use ISO 8601 timestamps such as 2024-07-01T15:30:00Z.")
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None:
            return parsed.astimezone(UTC)
        if not zone_given:
            raise HTTPException(422, "Specify tz or an explicit UTC offset for each timestamp.")
        candidates = set()
        for fold in (0, 1):
            utc = parsed.replace(tzinfo=zone, fold=fold).astimezone(UTC)
            if utc.astimezone(zone).replace(tzinfo=None) == parsed:
                candidates.add(utc)
    except (OverflowError, ValueError):
        raise HTTPException(422, "Invalid timestamp.") from None
    if len(candidates) != 1:
        raise HTTPException(
            422, "Local time is ambiguous or nonexistent. Supply an explicit UTC offset."
        )
    return candidates.pop()


def query_window(
    start: str | None,
    end: str | None,
    start_date: date | None,
    days: int | None,
    zone: ZoneInfo,
    zone_given: bool,
    today: date,
) -> tuple[datetime, datetime, list[date]]:
    if start is not None or end is not None:
        if start is None or end is None or start_date is not None or days is not None:
            raise HTTPException(422, "Supply both start and end, or use start_date and days.")
        lower = instant(start, zone, zone_given)
        upper = instant(end, zone, zone_given)
    else:
        duration = days or 1
        first = start_date or today - timedelta(days=duration - 1)
        if first > today - timedelta(days=duration - 1):
            raise HTTPException(422, "The requested date window extends past today in UTC.")
        lower = datetime.combine(first, time.min, UTC)
        upper = lower + timedelta(days=duration)
    if upper <= lower:
        raise HTTPException(422, "end must be later than start.")
    if upper > datetime.combine(today + timedelta(days=1), time.min, UTC):
        raise HTTPException(422, "The requested window extends past today in UTC.")
    # Accept the exclusive midnight of the last day without requesting the next day.
    last = (upper - timedelta(microseconds=1)).date()
    count = (last - lower.date()).days + 1
    if count > MAX_UTC_DAYS:
        raise HTTPException(422, f"Query at most {MAX_UTC_DAYS} UTC calendar days at once.")
    return lower, upper, [lower.date() + timedelta(days=i) for i in range(count)]
