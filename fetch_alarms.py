import base64
import json
import os
import ssl
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = os.environ.get("SPECTRUM_BASE_URL", "https://dev-spectrum.forwardinc.biz/spectrum/restful")
USER = os.environ.get("SPECTRUM_USER", "spectrum")
PASSWORD = os.environ.get("SPECTRUM_PASSWORD", "spectrum")

# Attribute IDs you typically want back on each alarm
ATTRS = [
    "0x11f56",  # Severity (int: 0=Normal, 1=Minor, 2=Major, 3=Critical, ...)
    "0x11f4e",  # Creation time (epoch seconds)
    "0x1006e",  # Model name
    "0x10000",  # Model type name
    "0x129fa",  # Alarmed model handle
    "0x11f9c",  # Probable cause ID
    "0x12022",  # Trouble ticket ID
]

SEVERITY = {0: "Normal", 1: "Minor", 2: "Major", 3: "Critical",
            4: "Maintenance", 5: "Suppressed", 6: "Initial"}

# Dev server uses a self-signed cert; verification disabled.
SSL_CTX = ssl._create_unverified_context()

_basic = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
_AUTH_HEADER = {"Authorization": f"Basic {_basic}"}


def _send(method, url, body=None, headers=None, timeout=30):
    hdrs = {"Accept": "application/json", **_AUTH_HEADER, **(headers or {})}
    data = body.encode() if isinstance(body, str) else body
    req = Request(url, data=data, method=method, headers=hdrs)
    with urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.loads(r.read().decode())


def list_alarms(throttle=200, landscape=None):
    """Simple GET — returns every current alarm with selected attributes."""
    params = [("attr", a) for a in ATTRS] + [("throttlesize", str(throttle))]
    if landscape:
        params.append(("landscape", landscape))
    return _send("GET", f"{BASE}/alarms?{urlencode(params)}")


def search_alarms_last_hours(hours=24, exclude_symptoms=True):
    """POST search ('GET tunneling') — alarms created in the last N hours."""
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<rs:alarm-request throttlesize="0"
    xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">
  {''.join(f'<rs:requested-attribute id="{a}"/>' for a in ATTRS)}
</rs:alarm-request>"""
    qs = urlencode({"lasthour": hours, "symptoms": "no" if exclude_symptoms else "yes"})
    return _send(
        "POST",
        f"{BASE}/alarms?{qs}",
        body=body,
        headers={"Content-Type": "application/xml"},
        timeout=60,
    )


def search_alarms_for_device(model_name, throttle=200):
    """POST search — alarms whose alarmed model name (0x1006e) equals model_name."""
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<rs:alarm-request throttlesize="{throttle}"
    xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">
  <rs:attribute-filter>
    <search-criteria xmlns="http://www.ca.com/spectrum/restful/schema/filter">
      <filtered-models>
        <and><or>
          <equals>
            <attribute id="0x1006e">
              <value>{model_name}</value>
            </attribute>
          </equals>
        </or></and>
      </filtered-models>
    </search-criteria>
  </rs:attribute-filter>
  {''.join(f'<rs:requested-attribute id="{a}"/>' for a in ATTRS)}
</rs:alarm-request>"""
    return _send(
        "POST",
        f"{BASE}/alarms",
        body=body,
        headers={"Content-Type": "application/xml"},
        timeout=60,
    )


def pretty(payload):
    resp = payload.get("alarm-response-list", payload)
    alarms = resp.get("alarm-responses", {}).get("alarm", []) or []
    if isinstance(alarms, dict):
        alarms = [alarms]
    for alarm in alarms:
        raw_attrs = alarm.get("attribute", []) or []
        if isinstance(raw_attrs, dict):
            raw_attrs = [raw_attrs]
        attrs = {a.get("@id", a.get("id")): a.get("$", a.get("#text", a.get("value")))
                 for a in raw_attrs}
        sev = SEVERITY.get(int(attrs.get("0x11f56") or 0), "?")
        print(f"{alarm.get('@id', alarm.get('id'))}  {sev:<8}  {attrs.get('0x1006e', '')}")


if __name__ == "__main__":
    pretty(search_alarms_for_device("vEdge_002_Miami"))
    # pretty(list_alarms(throttle=100))
    # pretty(search_alarms_last_hours(hours=6))
