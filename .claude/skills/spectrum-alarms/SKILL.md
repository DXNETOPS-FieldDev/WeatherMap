---
name: spectrum-alarms
description: Fetch or interpret alarms from Broadcom DX NetOps Spectrum's RESTful API. Use whenever the user asks to query, list, count, filter, update, or clear Spectrum alarms, or asks about Spectrum alarm attribute IDs / severity codes. Covers the dev server at dev-spectrum.forwardinc.biz and the documented `/spectrum/restful/alarms` endpoints generally.
---

# Spectrum Alarms

Reference and recipes for the Broadcom DX NetOps Spectrum REST API alarm endpoints. The single most important fact in this skill is that **some attribute IDs in the public techdocs are wrong** for the alarm-response payload — see the "Verified attribute IDs" section.

## Verified attribute IDs (alarm responses)

These were confirmed against live JSON from `dev-spectrum.forwardinc.biz`. Public Broadcom techdocs label `0x11f4e` as severity and `0x11f56` as creation time — **that mapping is inverted from what the server actually returns**. Always trust the live response.

| Attribute ID | Meaning | Notes |
|---|---|---|
| `0x11f56` | **Severity** | int 0–6 (see severity map below) |
| `0x11f4e` | **Creation time** | epoch seconds |
| `0x1006e` | Model name | string (e.g. `vEdge_002_Miami`) |
| `0x10000` | Model type name | string (e.g. `NetworkPath`, `Rtr_Cisco`, `ViptelaDev`) |
| `0x129fa` | Alarmed model handle | hex string |
| `0x11f9c` | Probable cause ID | **alarm UUID, not a foreign key to cause text** — matches the alarm's own `@id` for top-level alarms. Useless as a display label. |
| `0x12022` | Trouble ticket ID | often empty |
| `0x12b4c` | **Alarm Title** | Human-readable text OneClick shows (e.g. `"VIPTELA SYSTEM MEMORY USAGE"`, `"A Threshold Violation event has been raised on \"Viptela-CPU\". ..."`). Not surfaced in standard techdoc attribute lists, but populated and useful. **This is the attribute to request for UI display** — most other "cause text" / "symptom" candidates (`0x11650`, `0x12bfc`, `0x117ee`, `0x12c4d`, etc.) come back empty on this server. |
| `0x12d7f` | Network Address (IP) | e.g. `172.16.240.102` |
| `0x12adb` | Topology path | e.g. `MiamiSite:Default Domain:vEdge Devices` |
| `0x129e7` | Location | e.g. `Universe:United States:Miami` |
| `0x11f50` | Event / probable-cause code | numeric (e.g. `111411243` = `0x6A4002B`); the underlying event ID — useful for cross-referencing in OneClick but **not** human-readable. Use `0x12b4c` for display. |
| `0x10001` | Model type of alarmed model | hex handle (e.g. `0x6a40011`) |
| `0x1000a` | Condition | numeric, parallels severity |
| `0x11ee8` | Model class | numeric |

Severity values: `0=Normal, 1=Minor, 2=Major, 3=Critical, 4=Maintenance, 5=Suppressed, 6=Initial`.

For filtering: the user-supplied OneClick example uses `0x12d80` (a model attribute) as the IP filter key — distinct from `0x12d7f` (which is the alarm-response IP attribute). When in doubt, filter on model name `0x1006e` — it's the most reliable and easiest to confirm.

Before relying on any other attribute ID, sample a real response with `Accept: application/json` and inspect the `@id`/`$` pairs.

## Probable-cause text: not retrievable via attributes

Spectrum stores human-readable cause descriptions in server-side `EventDisp` / `CsEvFormat` config files, not as alarm attributes. Probed candidates that come back empty on `dev-spectrum.forwardinc.biz`: `0x11650`, `0x12bfc`, `0x117ee`, `0x12c4d`, `0x11651`, `0x12bea`. Endpoints like `/probable-cause/<code>`, `/event-types/<code>`, `/alarm/<id>` either 404 or return only the bare alarm `@id`. **Use `0x12b4c` (Alarm Title) — it's the closest the REST API gets to OneClick's display text.**

## Connection details for the dev server

- Base URL: `https://dev-spectrum.forwardinc.biz/spectrum/restful`
- Auth: HTTP Basic with `spectrum` / `spectrum`
- TLS: self-signed cert. Either disable verification (dev only) or load an internal CA bundle.
- A working stdlib example lives at `fetch_alarms.py` in the WeatherMap project root.

## Endpoint cheat sheet

```
GET    /alarms                      # list current alarms (attr=, landscape=, throttlesize=)
GET    /alarm/<id>                  # single alarm (singular noun)
POST   /alarms                      # rich search via <rs:alarm-request> XML body
                                    # query params: lasthour=N, symptoms=yes|no
GET    /alarms/filters              # named alarm filters defined in OneClick
POST   /alarms/count                # severity counts for a named filter
PUT    /alarms/<id>?attr=&val=      # update one attribute
POST   /alarms/update               # bulk update (v23.3.7+)
DELETE /alarms/<id>                 # clear/delete
```

Pagination: repeat the call increasing `throttlesize` (or follow the `link rel="next"` URL in the response) until `error="EndOfResults"`.

## Minimal request body for POST search

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rs:alarm-request throttlesize="0"
    xmlns:rs="http://www.ca.com/spectrum/restful/schema/request">
  <rs:requested-attribute id="0x11f56"/>
  <rs:requested-attribute id="0x11f4e"/>
  <rs:requested-attribute id="0x1006e"/>
  <rs:requested-attribute id="0x10000"/>
  <rs:landscape id="0x100000"/>
</rs:alarm-request>
```

Send with `Content-Type: application/xml` and `Accept: application/json` (or `application/xml`).

## JSON response shape (current server)

```json
{
  "alarm-response-list": {
    "@total-alarms": 250,
    "@throttle": 2,
    "alarm-responses": {
      "alarm": [
        {
          "@id": "6943b250-117e-1001-02f7-00801011046a",
          "attribute": [
            {"@id": "0x11f56", "$": "2"},
            {"@id": "0x11f4e", "$": "1766044240"},
            {"@id": "0x1006e", "$": "..."}
          ]
        }
      ]
    },
    "link": {"@rel": "next", "@href": "...&start=2&throttlesize=2"}
  }
}
```

Watch out:
- `attribute` is a list of `{"@id": ..., "$": ...}` objects — not a dict.
- Empty attributes return `{"@id": "0x12022"}` with no `$` key.
- When only one alarm matches, some servers collapse `alarm` from a list to a single object — handle both.

## Common pitfalls

- Severity comes back as a string of an int (`"2"`), not as `"Major"`. Cast before mapping.
- Connection resets to `files.pythonhosted.org` block `pip install requests` on this host — prefer the stdlib (`urllib.request`) so the script needs no install.
- Symptom alarms inflate counts; pass `symptoms=no` for the "actionable" view.
- `0x11f9c` is *not* a foreign key to a probable-cause description; it's the alarm-instance ID. Probable-cause text needs a separate lookup.

## When invoked

1. If the user wants live data, point them at (or reuse) `fetch_alarms.py` and confirm credentials/landscape before running.
2. Always sample one raw alarm response (`throttlesize=1`) and dump the JSON before writing parsing logic — schema can drift.
3. Use the verified attribute IDs above; if a number disagrees with public techdocs, the live response wins.
