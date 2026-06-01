#!/usr/bin/env python3
"""
ODIN coverage probe — gauges whether the free ODIN (Oak Ridge / DoE) real-time
outage feed is comprehensive enough to back a WeatherMap power-outage overlay.

Answers:
  1. How many active outage records exist right now?
  2. How many distinct states / utilities are reporting?
  3. Per-state outage count and total meters affected (top N)
  4. How fresh is the data (newest record timestamp + breakdown)?
  5. Data-quality snapshot (% of records with polygon, ETR, cause, etc.)

Run: python3 probe_odin.py
"""

import json
import ssl
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen

BASE = ("https://ornl.opendatasoft.com/api/explore/v2.1/"
        "catalog/datasets/odin-real-time-outages-county")

# macOS python.org installer ships without cert chain; this is a public,
# government-backed read-only API so cert verification isn't load-bearing here.
SSL_CTX = ssl._create_unverified_context()


def get(path, **params):
    url = f"{BASE}/{path}"
    if params:
        url += "?" + urlencode(params)
    with urlopen(url, timeout=30, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


def section(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def main():
    # ---------- 1. Total ----------
    section("1. Total active outage records")
    head = get("records", limit=1)
    total = head.get("total_count", 0)
    print(f"   {total} records currently in ODIN")
    if total == 0:
        print("   ⚠ Empty dataset — ODIN may be down, or no outages right now.")
        sys.exit(0)

    # ---------- 2. State coverage (server-side aggregation) ----------
    section("2. State coverage (outages + meters affected)")
    by_state = get(
        "records",
        select="state, count(*) as outages, sum(metersaffected) as meters",
        group_by="state",
        order_by="outages desc",
        limit=100,
    )
    states = by_state.get("results", [])
    print(f"   {len(states)} distinct states/territories with active outages\n")
    print(f"   {'State':<25} {'Outages':>10} {'Meters affected':>18}")
    print(f"   {'-'*25} {'-'*10} {'-'*18}")
    for row in states[:25]:
        st = (row.get("state") or "(unknown)")[:24]
        n = row.get("outages") or 0
        m = row.get("meters") or 0
        print(f"   {st:<25} {n:>10,} {m:>18,.0f}")
    if len(states) > 25:
        print(f"   ... and {len(states) - 25} more")

    # ---------- 3. Utility coverage ----------
    section("3. Utility coverage (top 15 by outage count)")
    by_util = get(
        "records",
        select="name, count(*) as outages, sum(metersaffected) as meters",
        group_by="name",
        order_by="outages desc",
        limit=15,
    )
    utils = by_util.get("results", [])
    print(f"   {'Utility':<48} {'Outages':>8} {'Meters':>12}")
    print(f"   {'-'*48} {'-'*8} {'-'*12}")
    for row in utils:
        nm = (row.get("name") or "(unknown)")[:47]
        n = row.get("outages") or 0
        m = row.get("meters") or 0
        print(f"   {nm:<48} {n:>8,} {m:>12,.0f}")

    # Distinct utility count
    distinct_utils = get(
        "records",
        select="count(distinct name) as n",
        limit=1,
    ).get("results", [{}])[0].get("n", "?")
    print(f"\n   {distinct_utils} distinct utilities reporting")

    # ---------- 4. Freshness ----------
    section("4. Data freshness")
    fresh = get(
        "records",
        select="max(reportedstarttime) as newest, min(reportedstarttime) as oldest",
        limit=1,
    ).get("results", [{}])[0]
    newest = fresh.get("newest")
    oldest = fresh.get("oldest")
    print(f"   Newest outage report: {newest}")
    print(f"   Oldest outage report: {oldest}")
    if newest:
        try:
            n_dt = datetime.fromisoformat(newest.replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - n_dt
            print(f"   Newest record age: {age} (HH:MM:SS)")
        except Exception:
            pass

    # ---------- 5. Quality ----------
    section("5. Data quality (sample of 100 records — API per-call cap)")
    sample = get("records", limit=100).get("results", [])
    n = len(sample)
    fields_present = Counter()
    for rec in sample:
        for key in ("geom", "geo_point_2d", "metersaffected",
                    "estimatedrestorationtime", "cause", "causekind",
                    "utility_id", "county", "statuskind"):
            v = rec.get(key)
            if v is not None and v != "":
                fields_present[key] += 1
    print(f"   {'Field':<28} {'Populated':>14}")
    print(f"   {'-'*28} {'-'*14}")
    for field, count in sorted(fields_present.items(), key=lambda x: -x[1]):
        pct = (count / n * 100) if n else 0
        print(f"   {field:<28} {count:>6}/{n} ({pct:>4.0f}%)")

    # ---------- 6. Sample record ----------
    section("6. Sample record (most recent)")
    if sample:
        rec = max(sample, key=lambda r: r.get("reportedstarttime") or "")
        compact = {k: v for k, v in rec.items()
                   if k not in ("geom", "centroid") and v not in (None, "")}
        if rec.get("geom"):
            compact["geom"] = (
                f"<{rec['geom'].get('type')} with "
                f"{len(rec['geom'].get('coordinates', []))} polygon(s)>"
            )
        print(json.dumps(compact, indent=2, default=str))

    # ---------- Verdict ----------
    section("VERDICT")
    n_states = len(states)
    if n_states >= 30:
        verdict = "STRONG"
    elif n_states >= 15:
        verdict = "MODERATE"
    else:
        verdict = "LIMITED"
    print(f"   Coverage breadth: {verdict} ({n_states} states reporting)")
    print(f"   Total impact:     {sum((r.get('meters') or 0) for r in states):,.0f} meters out")
    print(f"   Use as primary?   "
          f"{'Yes — viable backbone for a national overlay' if verdict == 'STRONG' else 'Probably need a fallback (paid feed) for states ODIN misses' if verdict == 'MODERATE' else 'No — too sparse, consider paid feed'}")


if __name__ == "__main__":
    main()
