# WeatherMap connectivity check

`check-connectivity.sh` checks, **before you install WeatherMap**, that the NetOps Portal server can reach
every service WeatherMap uses. When something can't be reached, it tells you **why** (name resolution,
firewall, certificate, proxy, wrong URL or wrong credentials) and what to do about it.

It changes nothing on the server. It only reads, and writes one log file you can send to us.

## Why run it

WeatherMap pulls data from several services. Some are inside your network (Spectrum, the Data
Aggregator, NCM), and some are on the internet (AppNeta, map tiles, weather, radar, power outages).
Firewalls, web proxies and TLS inspection commonly block one of them. After an install, that only
shows up as an empty layer or an error in the map, with no explanation.

Running this check first turns that into a list you can act on, for example: *"TCP timed out: ask for a
firewall rule 10.1.2.3 → 10.4.5.6 port 8443/tcp"*, or *"certificate not trusted by the Portal's Java:
set ncm.ssl.verify=false or import the CA"*. You can do this before the install window, not during it.

## What it checks

There are two groups of services, because WeatherMap reaches them in two different ways.

**1. Services the Portal server calls**: WeatherMap's server-side proxies (`*-proxy.jsp`) connect to
these from inside the Portal's Java. This check tests exactly that path.

| Service | Needed when | What the check sends |
|---|---|---|
| Spectrum | you show Spectrum alarms on the map | `GET <url>restful/landscapes` |
| AppNeta | you show AppNeta Monitoring Points and paths | `GET <url>v3/organization` |
| Data Aggregator (DA) | you use AppNeta (it links paths to Performance Center) | `POST` to WeatherMap's network-path query |
| NCM | you show configuration compliance | `POST <url>rest/api/v1/auth/token` |

It asks about each one first. Answer **no** for any service you don't use, and it is skipped and never
contacted. The DA question defaults to yes, because the DA is part of every NetOps Portal installation.

**2. Services the users' browsers call**: map tiles, weather, radar and power outages.

| Service | What the check fetches |
|---|---|
| OpenStreetMap | one map tile from each of `a.`, `b.` and `c.tile.openstreetmap.org` |
| OpenWeatherMap | one weather tile, and the current-conditions API |
| RainViewer | the radar frame list, then one radar tile |
| ODIN (power outages) | one outage record |

> **Important:** in WeatherMap, the **users' browsers** load these, not the Portal server. A pass here
> shows that your network lets the Portal server reach them. It does **not** prove that a user's
> workstation can, which often goes through a different proxy and firewall policy. It also doesn't test
> the Portal's Content-Security-Policy header, if you have set one. Check those separately, from a
> workstation.

## Requirements

- Run it **on the NetOps Portal server** (the machine running Performance Center). Run from anywhere
  else, the results don't tell you what the Portal can reach.
- `bash` 4 or later, `curl` and `openssl`. These are standard on RHEL and Rocky Linux 8 and 9.
- WeatherMap doesn't need to be installed. If it is, the check offers the saved addresses and
  credentials as defaults, so you can also use it to troubleshoot an existing install.

## Download and run

On the Portal server:

```bash
curl -fsSLO https://raw.githubusercontent.com/DXNETOPS-FieldDev/WeatherMap/main/tools/connectivity-check/check-connectivity.sh
sudo bash check-connectivity.sh
```

If the server can't reach GitHub, download `check-connectivity.sh` on your workstation from this
folder (the **Raw** button) and copy it across with `scp`.

- Run it with **`bash`**, not `sh` and not `./check-connectivity.sh`. It needs bash, and the executable
  bit may not survive the copy.
- **`sudo`** (or the account that runs Performance Center) is only needed to read an existing
  WeatherMap install's saved settings, which are readable by their owner only. Without it, the check
  still runs and you type the addresses yourself.
- To check as if WeatherMap weren't installed (ignore the saved settings):
  `sudo bash check-connectivity.sh --app-dir /none`
- Other options: `bash check-connectivity.sh --help`.

## What it asks

```
Does this Portal use Spectrum with WeatherMap? [y/N]: y
  Spectrum URL (e.g. https://spectrum-host:8443/spectrum/): https://spectrum.example.com:8443/spectrum/
  Also test the login? [y/N]: y
  User name: weathermap
  Password:
```

The same questions follow for AppNeta (organization ID and API token instead of a user name and
password), the Data Aggregator and NCM. Then:

```
Also check OpenStreetMap, OpenWeatherMap, RainViewer and ODIN from this server? [Y/n]:
```

- **Enter** takes the default, shown in capitals.
- The **login test is optional**. Without it, the check proves the service is reachable and is the
  right product. With it, it also proves the account works. Use the account WeatherMap will use.
- The password and token are typed hidden. They're sent to the service in the request body or headers
  only. They never appear on the command line, on screen, or in the log.
- **Use the addresses as the Portal server reaches them.** These are the URLs you'll later give
  `setup.sh`: for example NCM's internal address and port, not the address users type in a browser.

## Reading the output

Each service is checked in layers, and the check stops at the first one that fails:

```
== NCM
    Address: https://10.20.30.40:8880/ncm-webapp/
    DNS: 10.20.30.40 is an IP address, no lookup needed
    TCP: connected to 10.20.30.40:8880
    TLS: certificate for ... CN = ncm01
         issued by ... CN = MASTERKEY, valid until Oct 27 21:01:38 2036 GMT
    TLS: NOT trusted by the Portal's Java: unable to get local issuer certificate
      → with ncm.ssl.verify=true (the default) WeatherMap will refuse this server. Either:
      →   import the issuing CA into /opt/CA/jre/lib/security/cacerts (keytool -importcert) and restart the Portal, or
      →   set ncm.ssl.verify=false when you run setup.sh (accepts any certificate from this server)
    HTTP: NCM's REST API answered (HTTP 401, asks for a login)
```

Lines starting with **→** give the cause and the fix. At the end there's a summary:

```
SERVICE          RESULT   TARGET                                   DETAIL
Spectrum         OK       spectrum.example.com:8443                reachable, login OK
AppNeta          OK       tenant.pm.appneta.com:443                reachable, login OK
Data Aggregator  OK       da.example.com:8582                      reachable, login OK
NCM              WARN     10.20.30.40:8880                         certificate not trusted by the Portal's Java: ...
OpenStreetMap    OK       a.tile.openstreetmap.org:443             reachable
...
Result: 7 OK, 1 WARN, 0 FAIL, 0 SKIPPED (of 8 services)
```

| Result | Meaning |
|---|---|
| **OK** | Reachable, and it is the right service. With a login test, the account was accepted too. |
| **WARN** | Reachable, but WeatherMap won't work with it as things stand (usually a certificate setting), or something unexpected came back. Read the `→` lines. |
| **FAIL** | Not reachable or not usable. WeatherMap's feature for this service won't work until it's fixed. |
| **SKIPPED** | You said you don't use it. |

The exit code is **0** when nothing failed and **1** when anything failed, so it can be used in a
script. WARN doesn't change the exit code.

The **log file** `weathermap-connectivity-<server>-<time>.log` is written to the folder you ran it from
(or `/tmp` if that folder isn't writable). It holds everything shown on screen, and no passwords or
tokens. It does contain host names and IP addresses, so send it only to people who should see
those.

## Common results and what to do

| Message | What it means | What to do |
|---|---|---|
| `DNS: FAILED — '<name>' does not resolve` | The Portal server's DNS doesn't know that name | Check the spelling. Ask for a DNS record, or add an `/etc/hosts` entry on the Portal server |
| `TCP: ... refused` | The host answered, but nothing accepts connections on that port | Check the port number, and that the service is running. A firewall may also be actively rejecting it |
| `TCP: ... timed out` | No answer at all, usually a firewall silently dropping the traffic | Send the firewall team the rule the check prints: *source IP → target IP, port/tcp* |
| `TCP: ... no route to host` | The server has no network path to that address | Routing or firewall: same request as above |
| `port N answers, but not with TLS` | You used `https://` on a plain-HTTP port | Use `http://`, or the service's HTTPS port |
| `the server says this port expects HTTPS` | You used `http://` on an HTTPS port | Use `https://` |
| `404 Not Found` | The server is right, the path is wrong | Use the path shown: Spectrum `/spectrum/`, AppNeta `/api/`, NCM `/ncm-webapp/` |
| `NOT trusted by the Portal's Java` | The certificate's issuer isn't in Performance Center's Java truststore (common for NCM and internal servers) | Set `<service>.ssl.verify=false` in `setup.sh`, or import the certificate (see below) |
| `the OS trusts it but Java doesn't` | Your CA is installed in the operating system, but not in the Java that Performance Center uses | Import it into Java's truststore (see below) |
| `certificate doesn't match '<host>'` | The certificate is trusted, but it's for a different name (often when you use an IP address) | Use one of the names the check lists, or set `ssl.verify=false` |
| `the certificate has EXPIRED` | The service's certificate is out of date | The service's owner renews it. Until then it only works with `ssl.verify=false` |
| `looks like an intercepting (TLS-inspecting) proxy` | A security proxy re-signs the traffic | Ask for an inspection bypass for that host, or trust the proxy's CA |
| `got a web page ... blocked by a proxy?` | Something answered with an HTML page where an image or JSON was expected | Usually a web proxy's block or login page: ask for the host to be allowed |
| `Login: FAILED — ... rejected` | Reachable, but the account or token is wrong | Check the credentials. For AppNeta, create a new API token |
| `the token works, but organization N isn't one it can see` | AppNeta token OK, organization ID wrong | Use one of the organization IDs it lists |
| `HTTP 401 'Invalid API key'` (OpenWeatherMap, before install) | Expected: there's no key to test yet, and the path is open | Nothing to do |

### Proxies: the gotcha that matters most

- **WeatherMap's server-side calls ignore the shell's `https_proxy` / `http_proxy` variables.** They
  run inside Performance Center's Java, which only uses a proxy if one is configured for that Java
  (`-Dhttps.proxyHost` / `-Dhttps.proxyPort` in `PC/conf/wrapper.conf`). The check prints which applies.
- If a service fails directly but works through your shell's proxy, the check says so. For Spectrum,
  AppNeta, DA and NCM that means WeatherMap **still won't reach it**. You need a direct firewall rule,
  or a Java proxy setting, which affects the whole Portal.
- For the browser services (map tiles, weather and so on), working only through a proxy is normal,
  because users' browsers usually go through the proxy too.

### Importing a certificate into the Portal's Java truststore

Use this instead of `ssl.verify=false` if your security policy requires certificate checks. Run it on
the Portal server as root. Set `HOST` and `PORT` to the service's address. `JRE` is Performance
Center's Java (the check prints its truststore path: use the folder above `lib/security`).

```bash
HOST=ncm.example.com PORT=8880 JRE=/opt/CA/jre
cp -p "$JRE/lib/security/cacerts" "$JRE/lib/security/cacerts.bak-$(date +%Y%m%d)"
openssl s_client -connect "$HOST:$PORT" -servername "$HOST" -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/{n++; p=1} p{print > ("cert" n ".pem")} /END CERT/{p=0}'
openssl x509 -noout -subject -issuer -in cert1.pem
"$JRE/bin/keytool" -importcert -noprompt -alias "weathermap-$HOST" -file cert1.pem \
  -keystore "$JRE/lib/security/cacerts" -storepass changeit
```

- This imports the server's own certificate (`cert1.pem`). If your PKI team can give you the **issuing
  CA** certificate instead, import that: it keeps working when the server's certificate is renewed.
- `changeit` is Java's default truststore password. If your organization changed it, use theirs.
- **Restart Performance Center** afterwards, so its Java reads the truststore again. Then run the check
  again: it should now say `trusted by the Portal's Java`.
- An upgrade of Performance Center may replace its Java and the truststore with it. Re-check after one.

## Good to know

- **It takes a few seconds per service.** Unreachable services take longer: each address waits up to
  8 seconds for a connection and 20 seconds for an answer.
- **Only the checks you answer yes to make network connections.** A skipped service is never contacted.
- **`ssl.verify=false` turns off both the certificate check and the name check** for that service in
  WeatherMap. It's common for NCM, whose certificate is usually self-issued. It's your security
  decision: the alternative is importing the certificate, as described above.
- **"The certificate expires within 30 days"** is only a note, not a failure. It's worth telling the
  service's owner.
- **Run it again after every fix.** It's quick, and it confirms the fix.
- **It can't see** the users' workstations, the Portal's Content-Security-Policy, or anything beyond
  the first request to each service (for example permissions on individual Spectrum models).

## For maintainers

`test/connectivity-cases.sh` runs 13 cases (each failure type, a full OK run with logins, and a scan
proving no saved secret reaches the output or the log). It runs on a Portal server with a configured
WeatherMap install. Its header lists the lab targets it needs as environment variables.
