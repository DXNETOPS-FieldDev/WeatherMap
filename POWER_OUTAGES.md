# Power Outages — Feature Brief

A togglable layer in the NetOps WeatherMap that overlays utility-reported
**active power outages** on the same map as your network devices, and
automatically flags devices whose location falls inside an active outage area.

This document is for **decision-makers** evaluating whether the feature is
worth keeping in the App View. It is deliberately candid about what the
feature does **not** do, because the value of the feature depends entirely
on whether the data source covers your specific service territory.

---

## TL;DR

**Keep this feature if** your network footprint is concentrated in regions
where the data source has strong coverage (Texas, Pacific Northwest,
Southern California, Northeast/Mid-Atlantic, Upper Midwest, North Carolina,
Tennessee). The feature adds **NOC context for free** — you'll see at a
glance when a device is dark because the utility lost power, not because
the device failed.

**Consider dropping this feature if** your network is heavily concentrated
in regions the data source does **not** cover well — most notably **Florida**
(FPL, Duke Energy Florida) and **Northern California** (PG&E). In those
areas, the absence of a power-outage indicator gives operators **false
confidence** that "no warning = no outage," which is worse than no feature
at all.

---

## What the operator actually sees

1. **A "Power Outages (N)" toggle** in the layer control (top-right corner).
   N is the live count of currently-active outages in the data feed.
2. **Colored polygons** when toggled on — yellow / orange / red / dark-red
   based on customer count (1–9 / 10–99 / 100–999 / 1000+ meters).
3. **A clickable polygon popup** with utility name, county / state, meters
   affected, status (e.g. "Crew Assessing"), cause (when reported), reported
   start time, and estimated restoration time (when known).
4. **An automatic banner in any device's Site Info popup** when that device
   sits inside an active outage polygon:
   > ⚡ **Possible power outage in this area**
   > Puget Sound Energy Inc
   > 58 meters affected · Awaiting Crew Assignment
   > Cause: Accident

---

## Where the data comes from

| Aspect | Value |
|---|---|
| Source | **ODIN** — Outage Data Initiative Nationwide |
| Operated by | Oak Ridge National Laboratory + US DoE Office of Electricity |
| Cost | **Free, no API key, no quota** |
| Coverage | US only (no Canada, no UK) |
| Update frequency | Every ~10 minutes (matches commercial feeds) |
| Data shape | GeoJSON polygons of affected service areas |

ODIN is a **standardized digital reporting format** that utilities can opt
into. Their data is published in real time at county granularity. The
quality of the feature is therefore bounded by who chooses to participate.

---

## What you're getting (benefits)

| Benefit | What it means in practice |
|---|---|
| **Zero licensing cost** | Comparable commercial feeds (PowerOutage.us, Gisual) require a quote-based paid subscription. ODIN is free indefinitely. |
| **Real-time freshness** | Records typically <20 minutes old, matching the cadence of paid alternatives. |
| **Government-backed credibility** | Data flows from utilities through a DoE-managed standard, not scraped from public outage maps. |
| **Polygon-level detail** | You see the actual reported service area affected, not just a point. Gives operators a sense of outage extent. |
| **Automatic device correlation** | When a device's coordinates fall inside an active outage polygon, the popup proactively flags "Possible power outage in this area." Operators can rule out an external cause without leaving the map. |
| **No new infrastructure** | Browser calls ODIN directly. No new proxy, no new server. Only addition is one CSP whitelist line. |
| **Non-fatal failure mode** | If ODIN is unreachable, the rest of the WeatherMap keeps working — just no outage layer. |
| **Configurable without a rebuild** | Endpoint, pagination cap, and other tuning live in `runtime-config.json` — editable in the unzipped App View. |
| **Toggleable** | Off by default; operators turn it on when relevant. No clutter for users who don't care. |

---

## What you're NOT getting (honest limitations)

### 1. Coverage is incomplete and uneven

ODIN participation is voluntary. From a probe of the live feed during a
calm weather period (May 2026), we observed:

- **34 states** with at least one active outage reported
- **64 distinct utilities** participating
- **Notable utilities reporting**: CenterPoint Energy (TX), PacifiCorp (West),
  Southern California Edison, National Grid, AVANGRID, Evergy, Portland
  General Electric, Consumers Energy (MI), Met-Ed (PA), Ohio Edison,
  Monongahela Power (WV), Puget Sound Energy
- **Notable utilities NOT reporting** (or under-reporting):
  - **Florida Power & Light** — Florida had **zero outages** in the sample
  - **Pacific Gas & Electric (PG&E)** — Northern California is essentially
    invisible; California's coverage is concentrated around SCE territory
  - **Georgia Power, Duke Energy (parts of NC/SC/FL)** — sparse or absent

**This is the most important limitation to understand**: in a region where
the local utility doesn't report to ODIN, **the absence of a polygon does
not mean the lights are on.** The feature can be silent during a real
outage if the utility isn't participating.

### 2. Not every field is always populated

From a sample of 100 records:

| Field | Populated |
|---|---|
| Geometry (polygon shape) | 100% |
| Meters affected | 100% |
| County / state / utility name | 100% |
| **Estimated restoration time** | **46%** |
| **Cause description** | **40%** |
| **Status (e.g. "Crew Dispatched")** | **29%** |

So the device-popup banner can sometimes say only the bare minimum: "X
meters affected." Cause / ETR / status fields appear when the utility
provides them, which is less than half the time.

### 3. Polygons are coarse approximations

The polygons are **utility service-area approximations**, not exact
street-level outage extents. A device whose coordinates fall inside a
polygon is **in the affected area**, but the polygon may include addresses
that still have power. The popup explicitly says "**Possible** power
outage" rather than "Confirmed" for this reason. Treat the signal as
"investigate / wait" rather than "definitely no AC at this site."

### 4. No customer-count denominator

`metersaffected` is a raw integer. There is no "X% of customers in this
county" or "X of Y total customers served." Operators get absolute numbers
only.

### 5. No marker visual badge

The correlation surfaces only in the **popup** — the device marker on the
map looks identical whether or not it's inside an outage area. Operators
have to open the popup to see the warning.

### 6. No alarm-level annotation

The **Alarms tab** of the device popup does not annotate individual alarms
as "may be power-related." Operators see the outage banner on the Site Info
tab but must mentally connect it to the alarm list themselves.

### 7. Stale records can persist

ODIN does not always purge restored outages quickly. We observed records
that were 11 days old in the active feed. Most are recent, but a small
fraction may show old outages that have actually been resolved.

### 8. US only

ODIN is a US Department of Energy program. Canadian and other non-US sites
in your network footprint will never have a polygon — even during real
outages.

---

## What it would cost to fill the biggest gaps

If the coverage gaps above are dealbreakers, the realistic alternative is
to buy data from a commercial provider:

| Provider | Coverage claim | Pricing |
|---|---|---|
| **PowerOutage.us** | 94% US, 95% Canada, 89% UK customers | Quote-based; no public pricing |
| **PowerOutage.com** (sister site) | Same as above | Quote-based |
| **Gisual** | US + others | Quote-based |

A **hybrid approach is also possible**: keep ODIN as the free baseline and
add a paid feed only for the specific regions where ODIN is weak (e.g.
Florida). This is more work to integrate but cheaper than buying a full
nationwide commercial feed.

---

## What we could still add (not built)

These were deliberately deferred to keep the initial feature small. None
are commitments — each is a discussion if the feature is kept:

- **Marker visual badge** (a ⚡ icon overlay on the device marker so the
  outage state is visible at-a-glance without opening the popup)
- **Alarms tab annotation** ("this alarm may be power-related" tag on
  alarms whose device is inside an outage polygon)
- **Coverage-gap banner** at the top of the map for groups in FL / NorCal
  that explicitly says "outage data may be incomplete here"
- **Legend entry** for the polygon color scale (currently the legend only
  covers alarm severity)
- **Time-window filter** to suppress stale records (only show outages
  reported in the last N hours)
- **Hybrid data source** (mix ODIN with a paid feed for gap regions)

---

## Decision checklist

Walk through these to decide:

1. **Where is your network footprint?**
   - Mostly in Texas, the West Coast (excluding NorCal), the Northeast,
     the Mid-Atlantic, the Upper Midwest, or the Carolinas → **Keep**, ODIN
     covers you well.
   - Mostly in Florida or Northern California → **Likely drop**, or budget
     for a commercial feed.
   - Mixed → **Keep with a coverage-gap banner** (we'd add #4 from the
     "could still add" list).

2. **How much do operators value "rule out external cause" context?**
   - High value (NOCs that spend significant time triaging "is it us or
     the utility") → **Keep**, the correlation banner pays for itself.
   - Low value (NOCs that always escalate to field techs anyway) → **Drop**,
     the value-add is marginal.

3. **What's the cost of a false negative?**
   - If "no outage warning" gives operators false confidence and that costs
     more than the time saved by the feature → **Drop**.
   - If operators understand the data is best-effort and treat absence as
     "unknown, keep investigating" → **Keep**.

---

## Bottom line

The feature is **free, low-risk, and useful in the regions ODIN covers**.
The decision rests almost entirely on whether your client's network sits
in covered territory. If it does, the feature is a clear net win. If it
doesn't, the feature can mislead operators by suggesting silence equals
calm — and in that case, removing it is the right call.
