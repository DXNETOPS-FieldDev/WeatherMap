"""
Probe Spectrum REST to learn what's actually available for the
connectivity + port-health feature, before we write any UI code.

Four phases:
  1. Sweep all sample IPs through GET /connectivity/<ip>. Tells us whether
     Spectrum has ANY discovered topology for our devices.
  2. For one IP, look up the device model handle via a known-good models
     search (same pattern fetch_alarms.py uses, by 0x12d7f = network address).
     Confirms the device exists in Spectrum and gives us its mh for later
     queries.
  3. Try interfaces-of-devices-search to get interface model handles. If that
     yields nothing, fall back to the associations path documented in KB
     235422: GET /associations/relation/0x10004/model/<deviceMh>?side=left.
  4. For one interface model, GET /model/<mh> with no attr filter — see
     whether Spectrum dumps every populated attribute. That gives us ground
     truth on port-health attribute IDs.

Run: python probe_spectrum_topology.py
"""
import base64
import json
import os
import ssl
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = os.environ.get("SPECTRUM_BASE_URL", "https://dev-spectrum.forwardinc.biz/spectrum/restful")
USER = os.environ.get("SPECTRUM_USER", "spectrum")
PASSWORD = os.environ.get("SPECTRUM_PASSWORD", "spectrum")
SSL_CTX = ssl._create_unverified_context()
_basic = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
_AUTH = {"Authorization": f"Basic {_basic}"}

SAMPLE_IPS = [
    "172.16.240.103",  # vEdge_003_Chicago
    "172.16.240.2",    # vManage
    "172.16.240.150",  # vEdge_RP_NewYork
    "172.16.240.6",    # vSmart
    "172.16.240.10",   # vBond
    "172.16.240.101",  # vEdge_001_Houston
    "172.16.240.102",  # vEdge_002_Miami
    "172.16.240.104",  # cEdge_004_Denver
]

CANDIDATE_IFACE_ATTRS = [
    "0x1006e",  # Model_Name
    "0x10000",  # Model_Type_Name
    "0x10032",  # Model_Class
    "0x12d7f",  # Network_Address
    "0x1100c",  # Port_Status
    "0x10079",  # Port_Speed
    "0x1109b",  # If_Admin_Status
    "0x1109c",  # If_Oper_Status
    "0x1290c",  # ifIndex
    "0x130ba",  # Port_Description
    "0x1130d",  # ifInErrors
    "0x1130e",  # ifOutErrors
]


def _send(method, url, body=None, headers=None, timeout=30):
    hdrs = {"Accept": "application/json", **_AUTH, **(headers or {})}
    data = body.encode() if isinstance(body, str) else body
    req = Request(url, data=data, method=method, headers=hdrs)
    with urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.status, json.loads(r.read().decode())


def _safe_dict(x):
    return x if isinstance(x, dict) else {}


def _flatten_attrs(model):
    raw = _safe_dict(model).get("attribute", []) or []
    if isinstance(raw, dict):
        raw = [raw]
    out = {}
    for a in raw:
        aid = _safe_dict(a).get("@id", _safe_dict(a).get("id"))
        val = _safe_dict(a).get("$", _safe_dict(a).get("#text", _safe_dict(a).get("value")))
        if aid is not None:
            out[aid] = val
    return out


# ---------- Phase 1 ----------

def sweep_connectivity():
    print("=" * 60)
    print("PHASE 1 — GET /connectivity/<ip> across all sample IPs")
    print("=" * 60)
    for ip in SAMPLE_IPS:
        try:
            status, data = _send("GET", f"{BASE}/connectivity/{ip}")
        except Exception as e:
            print(f"  {ip}: FAILED {e}")
            continue
        resp = data.get("connection-response-list", data)
        if isinstance(resp, str):
            print(f"  {ip}: empty (HTTP {status}, body='{resp}')")
            continue
        conns = _safe_dict(resp).get("connection-response", []) or []
        if isinstance(conns, dict):
            conns = [conns]
        print(f"  {ip}: {len(conns)} edge(s)")
        for i, c in enumerate(conns[:3]):
            left = _safe_dict(c.get("connection-element-left"))
            right = _safe_dict(c.get("connection-element-right"))
            print(f"     [{i}] {left.get('name','?')} ({left.get('type','?')})"
                  f"  <-->  {right.get('name','?')} ({right.get('type','?')})")


# ---------- Phase 2 ----------

def find_device_model_and_ports(ip):
    """Filter models where network-address == ip. Returns the device model AND
    all its interface ports — they share the network address attribute on
    this server, so one query covers both."""
    print("\n" + "=" * 60)
    print(f"PHASE 2 — POST /models, all models with 0x12d7f={ip}")
    print("=" * 60)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<rs:model-request throttlesize="10"
    xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">
  <rs:target-models>
    <rs:models-search>
      <rs:search-criteria xmlns="http://www.ca.com/spectrum/restful/schema/filter">
        <filtered-models>
          <equals>
            <attribute id="0x12d7f"><value>{ip}</value></attribute>
          </equals>
        </filtered-models>
      </rs:search-criteria>
    </rs:models-search>
  </rs:target-models>
  <rs:requested-attribute id="0x1006e"/>
  <rs:requested-attribute id="0x10000"/>
  <rs:requested-attribute id="0x12d7f"/>
</rs:model-request>"""
    try:
        status, data = _send("POST", f"{BASE}/models", body=body,
                             headers={"Content-Type": "application/xml"})
    except Exception as e:
        print(f"  FAILED: {e}")
        return None
    print(f"  HTTP {status}; raw (first 800):")
    print(json.dumps(data, indent=2)[:800])
    resp = data.get("model-response-list", data)
    if not isinstance(resp, dict):
        return None
    models = _safe_dict(resp.get("model-responses")).get("model", []) or []
    if isinstance(models, dict):
        models = [models]
    print(f"\n  matched models: {len(models)}")
    if not models:
        return None
    for m in models:
        attrs = _flatten_attrs(m)
        mh = m.get("@mh", m.get("mh"))
        print(f"    mh={mh}  name={attrs.get('0x1006e','?')}  type={attrs.get('0x10000','?')}")
    return models


# ---------- Phase 3 ----------

def list_interfaces_via_search(ip):
    print("\n" + "=" * 60)
    print(f"PHASE 3a — POST /models <interfaces-of-devices-search> for {ip}")
    print("=" * 60)
    attrs_xml = "".join(f'<rs:requested-attribute id="{a}"/>' for a in CANDIDATE_IFACE_ATTRS)
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<rs:model-request throttlesize="50"
    xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">
  <rs:target-models>
    <rs:models-search>
      <rs:search-criteria xmlns="http://www.ca.com/spectrum/restful/schema/filter">
        <interfaces-of-devices-search>
          <network-address-set>
            <network-address>{ip}</network-address>
          </network-address-set>
        </interfaces-of-devices-search>
      </rs:search-criteria>
    </rs:models-search>
  </rs:target-models>
  {attrs_xml}
</rs:model-request>"""
    try:
        status, data = _send("POST", f"{BASE}/models", body=body,
                             headers={"Content-Type": "application/xml"}, timeout=60)
    except Exception as e:
        print(f"  FAILED: {e}")
        return []
    print(f"  HTTP {status}; raw (first 600):")
    print(json.dumps(data, indent=2)[:600])
    resp = data.get("model-response-list", data)
    if not isinstance(resp, dict):
        return []
    models = _safe_dict(resp.get("model-responses")).get("model", []) or []
    if isinstance(models, dict):
        models = [models]
    print(f"\n  interfaces returned: {len(models)}")
    for m in models[:5]:
        attrs = _flatten_attrs(m)
        mh = m.get("@mh", m.get("mh"))
        populated = sorted(k for k in attrs if attrs[k] not in (None, ""))
        print(f"    {mh}  {attrs.get('0x1006e','?')}  populated={populated}")
    return models


def list_interfaces_via_associations(device_mh):
    print("\n" + "=" * 60)
    print(f"PHASE 3b — GET /associations/relation/0x10004/model/{device_mh}?side=left")
    print("=" * 60)
    try:
        status, data = _send("GET", f"{BASE}/associations/relation/0x10004/model/{device_mh}?side=left")
    except Exception as e:
        print(f"  FAILED: {e}")
        return []
    print(f"  HTTP {status}; raw (first 800):")
    print(json.dumps(data, indent=2)[:800])
    return data


# ---------- Phase 4 ----------

def dump_one_interface_full(model_handle):
    print("\n" + "=" * 60)
    print(f"PHASE 4 — GET /model/{model_handle} (no attr filter)")
    print("=" * 60)
    try:
        status, data = _send("GET", f"{BASE}/model/{model_handle}")
    except Exception as e:
        print(f"  FAILED: {e}")
        return
    print(f"  HTTP {status}; raw (first 1200):")
    print(json.dumps(data, indent=2)[:1200])
    resp = data.get("model-response-list", data) if isinstance(data, dict) else {}
    if not isinstance(resp, dict):
        return
    models = _safe_dict(resp.get("model-responses")).get("model") or resp.get("model")
    if isinstance(models, list):
        models = models[0] if models else {}
    attrs = _flatten_attrs(models or {})
    print(f"\n  attributes returned: {len(attrs)}")
    for aid, val in sorted(attrs.items()):
        print(f"    {aid} = {str(val)[:80]}")


def list_alarmed_models():
    """Phase 5 — list every active alarm with its alarmed-model handle, name,
    and type. Tells us whether Spectrum raises any port-level alarms (alarms
    tied to Gen_IF_Port model handles) vs only device-level alarms."""
    print("\n" + "=" * 60)
    print("PHASE 5 — GET /alarms, group alarmed-model handles by model type")
    print("=" * 60)
    params = [
        ("attr", "0x129fa"),  # Alarmed model handle
        ("attr", "0x1006e"),  # Model name
        ("attr", "0x10000"),  # Model type
        ("attr", "0x12b4c"),  # Title
        ("throttlesize", "500"),
    ]
    try:
        status, data = _send("GET", f"{BASE}/alarms?{urlencode(params)}")
    except Exception as e:
        print(f"  FAILED: {e}")
        return
    resp = data.get("alarm-response-list", data) if isinstance(data, dict) else {}
    if not isinstance(resp, dict):
        print(f"  (alarm-response-list is {type(resp).__name__})")
        return
    alarms = _safe_dict(resp.get("alarm-responses")).get("alarm", []) or []
    if isinstance(alarms, dict):
        alarms = [alarms]
    print(f"  alarms returned: {len(alarms)}")
    by_type = {}
    rows = []
    for a in alarms:
        attrs = _flatten_attrs(a)
        mtype = attrs.get("0x10000") or "(no type)"
        by_type[mtype] = by_type.get(mtype, 0) + 1
        rows.append((mtype, attrs.get("0x129fa", "?"), attrs.get("0x1006e", "?"),
                     (attrs.get("0x12b4c", "") or "")[:60]))
    print("\n  alarmed-model-type breakdown:")
    for t, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
        print(f"    {n:>4}  {t}")
    print("\n  per-alarm (first 30):")
    for r in rows[:30]:
        print(f"    type={r[0]:<20} mh={r[1]:<14} name={r[2]:<40} title={r[3]}")


def dump_interface_with_candidates(model_handle):
    print("\n" + "=" * 60)
    print(f"PHASE 4b — GET /model/{model_handle} with candidate port attrs")
    print("=" * 60)
    qs = "&".join(f"attr={a}" for a in CANDIDATE_IFACE_ATTRS)
    try:
        status, data = _send("GET", f"{BASE}/model/{model_handle}?{qs}")
    except Exception as e:
        print(f"  FAILED: {e}")
        return
    print(f"  HTTP {status}; raw (first 1500):")
    print(json.dumps(data, indent=2)[:1500])


if __name__ == "__main__":
    sweep_connectivity()
    # Phase 2 returns device + its interface ports in one call (because the
    # network-address filter matches both). Use those directly.
    body_models = find_device_model_and_ports(SAMPLE_IPS[0])
    # Pick the first Gen_IF_Port for Phase 4.
    first_port_mh = None
    for m in body_models or []:
        attrs = _flatten_attrs(m)
        if attrs.get("0x10000") == "Gen_IF_Port":
            first_port_mh = m.get("@mh", m.get("mh"))
            break
    if first_port_mh:
        dump_one_interface_full(first_port_mh)
        dump_interface_with_candidates(first_port_mh)
    else:
        print("\n(no Gen_IF_Port found in Phase 2 result — skipping Phase 4)")
    list_alarmed_models()
