# OData 2.0 → 4.0 Conversion

DX NetOps Performance Management no longer supports OData 2.0. Every legacy App View whose code uses 2.0 must have its queries converted to 4.0 before the app can run. The user has a Python script — `convertToOdata4_patched.py` — that does the transformation: URL in, URL out. This file is the handoff protocol Claude follows.

## What the script does

It rewrites a single OData URL from 2.0 syntax to 4.0 syntax. The transformations include:

- **Path:** `/odata/` → `/odata4/`. Bare function names get parentheses: `/getSchemaVersion` → `/getSchemaVersion()`. `getGroupMetricFamilies?ID=42` → `getGroupMetricFamilies(ID=42)`.
- **Filter rewrites:** `substringof('x', field)` → `contains(field, 'x')`. `datetimeoffset'...'` → ISO 8601 with UTC. Navigation-property filters get lambda expressions — `groups/Name eq 'Routers'` becomes `groups/any(L1: L1/Name eq 'Routers')`. Known arrays like `GroupPathLocation` and `GroupChildren` are handled specially.
- **Select/expand restructure:** select terms with slashes (`cpumfs/Timestamp,cpumfs/im_Utilization`) move into `$expand=cpumfs($select=Timestamp,im_Utilization)`. The global `top=N` migrates into `$expand(...; $top=N)`.
- **Aggregation:** function name prefixes (`percentile95` → `f.percentile95`; same for `intercept`, `slope`, `datasetcount`). `projection` and `timetothreshold` absorb their associated query parameters into the function name (`f.projection86400`, `f.timetothreshold40`). Alias collisions get auto-renamed (`Value` → `Value_ag1`). If a filter references an aggregation alias, the script may restructure the whole query (aggregation reversal).
- **Misc:** old numeric suffixes stripped (`123L`, `42d` → plain numbers), whitespace inserted around OData keywords where Python's tokenizer ate it, optional percent-encoding via `--encoded`, Grafana macros like `${__from:date:seconds}` preserved.

The script also detects unquoted string literals in filters (`eq Boston` when the shell ate quotes) and warns with a shell-safe rewrite suggestion before aborting.

## The `/pc/` prefix issue (important)

The script's path-rewrite logic only triggers when the URL path **starts with** `/odata/`:

```python
if ps.startswith("/odata/"):
    ps = ps.replace("/odata/", "/odata4/")
```

App View URLs in JS code typically look like `/pc/odata/api/...` — the `/pc/` proxy prefix means the path *contains* `/odata/` but doesn't start with it. The guard fails and the path isn't rewritten, even though the query-string transformation still proceeds.

**Workaround:** when extracting an App View URL for the script, strip `/pc/` from the front. Re-add it after.

Round-trip example:

| Stage | URL |
|---|---|
| Original in JS | `/pc/odata/api/devices?$filter=groups/Name eq 'Boston'` |
| Sent to script | `http://placeholder.invalid/odata/api/devices?$filter=groups/Name eq 'Boston'` |
| Returned by script | `http://placeholder.invalid/odata4/api/devices?$filter=groups/any(L1: L1/Name eq 'Boston')` |
| Restored for the app | `/pc/odata4/api/devices?$filter=groups/any(L1: L1/Name eq 'Boston')` |

The `placeholder.invalid` host is just to satisfy `urlparse`; the script doesn't care what's there, and stripping it back out is a string replace.

## Invocation

The script is a standalone CLI:

```bash
python3 convertToOdata4_patched.py [options] '<full URL in single quotes>'
```

Useful flags:
- `-v` / `-vv` / `-vvv` — verbose output (helpful when the conversion looks off and you need to see the transformation steps)
- `--encoded` — percent-encode the output, useful for pasting into curl, a browser, or Grafana
- `-l <nav> [...]` / `--nolambda <nav> [...]` — opt out of lambda conversion for specific navigation properties (rarely needed)

The script prints the converted URL to stdout. Any warnings or verbose output go to stderr.

## Shell-safety

OData URLs contain single quotes around string literals (`eq 'Boston'`). When the user passes the URL on the command line, the shell will eat those quotes unless the whole URL is wrapped in single quotes — and any internal single quotes need to become `%27`.

The script warns and aborts if it detects what looks like a bare literal (e.g., `eq Boston` with no quotes), suggesting a shell-safe rewrite. Claude should pre-emptively format URLs for the user this way when handing them off:

- Replace every `'` inside the URL with `%27`
- Wrap the whole URL in single quotes for the shell

Example handoff format:

```bash
python3 convertToOdata4_patched.py 'http://placeholder.invalid/odata/api/devices?$filter=groups/Name eq %27Boston%27&$select=ID,Name'
```

## The handoff protocol

When Claude finds an OData 2.0 query in an existing app and conversion is needed:

1. **Reconstruct the full URL template** from the source JS. If the URL is assembled at runtime from string concatenation, splice it together with placeholder values for runtime-injected pieces:
   - Item ID — use a representative number like `123`
   - Timestamps — use any plausible Unix epoch like `1700000000`
   - Item names — use a quoted string like `'SampleDevice'`
   
   Keep track of where each placeholder lives in the URL — those are the slots that need to be re-parameterized in the converted React code.

2. **Apply the `/pc/` workaround.** Strip `/pc/` from the path and prepend `http://placeholder.invalid` so `urlparse` is happy and `startswith("/odata/")` matches.

3. **Apply shell-safety.** Replace every `'` inside the URL with `%27` and wrap in outer single quotes.

4. **Present the handoff to the user.** Format it clearly: the original URL (for their reference), the script-ready URL, the exact command to run, and a brief note about what to do with the result. Example:

   > Found this OData 2.0 query in `app.js`:
   > 
   > `/pc/odata/api/devices?$filter=groups/Name eq 'Boston'&$select=ID,Name`
   > 
   > To convert it, run:
   > 
   > ```bash
   > python3 convertToOdata4_patched.py 'http://placeholder.invalid/odata/api/devices?$filter=groups/Name eq %27Boston%27&$select=ID,Name'
   > ```
   > 
   > Paste the output back here and I'll integrate it into the converted app.

5. **Wait for the user.** Don't try to predict or hand-construct the 4.0 URL. The whole point of using the script is to get the correct, complete transformation.

6. **When the user returns the 4.0 URL:**
   - Replace `http://placeholder.invalid` with `/pc` to restore the proxy prefix
   - Wire the result into `src/api/odata.js`
   - Re-introduce the runtime placeholders (item ID, timestamps, etc.) from step 1 as JavaScript template literals or string interpolation
   - Update the rendering code to match the new response shape (aggregate aliases instead of `Value`, lambda result structures, etc.)

7. **Sanity-check.** The script handles a lot but not everything. After integration, review the 4.0 query against `odata-query-guide.md`:
   - Does the path correctly start with `/pc/odata4/api/`?
   - Are navigation filters using lambda syntax (`any(L1: ...)` or `all(L1: ...)`)?
   - Do aggregate functions have the `f.` prefix?
   - Are aggregation aliases meaningful, or did the script auto-rename to something cryptic like `Value_ag1`? (If cryptic, consider editing for readability — these become field names in the response and in the rendering code.)
   - Did `projection`/`timetothreshold` correctly absorb their parameters?
   
   If anything looks off, mention it to the user and consider re-running the script with `-v` for visibility into what happened.

## What the script doesn't handle (known unknowns)

The script's edge cases haven't been fully cataloged. If the converted URL produces incorrect data or a server error, possible culprits:

- **Bare `top=N` (no `$`) is not rewritten to `$top=N`.** In OData 2.0, `top=` and `$top=` were two different things (`top=` limited expanded rows per `$expand`, `$top=` limited result rows). 4.0 unifies on `$top=` and per-expand limits move inside the expand clause. The script doesn't convert bare `top=`, but in practice the 4.0 OData implementation seems to accept it — the query translator compiles it into a SQL `LIMIT` clause. So leaving it alone usually works. If you want to be explicit and 4.0-correct, rewrite manually to `$top=N`.
- **`length()` in filters causes a SQL error.** The 2.0 query function `length(<field>) ne 0` (used to test for non-empty strings) is not a recognized OData 4.0 function in the NetOps Performance Management implementation. The translator treats `length` as a property access, producing SQL like `v_dim_item.length(device_location_description) <> 0` which Vertica rejects with a misleading "Schema does not exist" error. Replace `length(<field>) ne 0` with `<field> ne null` — same intent, valid 4.0 syntax.
- Filters that mix lambda-able and non-lambda-able navigation properties in complex ways
- Aggregation pipelines with deeply nested groupby/filter chains
- Multi-property groupby that the script's "must reorder" detector classified incorrectly
- String literals containing characters the URL parser interpreted as delimiters
- Anything involving Grafana-style macros (`${...}`) in unusual positions — the script preserves them but doesn't validate them

If you see misbehavior, surface the verbose output (`-vv`) to the user and offer to walk through the transformation step by step. Don't try to silently hand-correct the script's output — that defeats the purpose of having a single source of truth for conversions.

## Diagnosing a converted query that returns HTTP 500

When the 4.0 server rejects the converted query, the response body almost always contains a useful error. Grab it from one of these places:

- **Browser DevTools** → Network → click the failing request → Response tab
- **Pasting the full URL into a new browser tab** — the active portal session authenticates you, and the OData server returns an HTML error page directly

For NetOps Performance Management specifically, the error body includes the SQL the OData translator generated. Read it: if the SQL looks malformed in any way, that's where the OData 4.0 syntax issue lives. Common patterns to watch for:

- `v_dim_item.<function>(<column>)` — an OData function was treated as a property method, meaning the function isn't recognized by the 4.0 translator
- "Schema does not exist" — usually misleading; the parser tripped on the previous token, not actually a missing schema
- "Column does not exist" — the OData property name doesn't match the underlying SQL column. May indicate a 2.0-specific property name that was renamed in 4.0

Whatever the SQL reveals, the fix is in the OData query — change the offending function or filter to a 4.0-compatible equivalent and try again.

## Worked example: WeatherMap devices query (full debug loop)

A real conversion that took several iterations, illustrating the workflow:

**Starting 2.0 query** (from the original Google-WeatherMap app):

```
/pc/odata/api/devices
  ?$apply=groupby(cpumfs/DeviceItemID, aggregate(cpumfs(im_Utilization with average as Value)))
  &$select=ID,Name,LocationDesc,Longitude,Latitude,PrimaryIPAddress
  &$filter=((length(LocationDesc) ne 0) and (groups/ID eq <id>))
  &starttime=<startTime>&endtime=<endTime>
  &resolution=HOUR
  &$format=text/csv
  &top=500
```

**After running through `convertToOdata4_patched.py`** (with `/pc/` workaround applied):

```
/pc/odata4/api/devices
  ?$apply=groupby((cpumfs/DeviceItemID), aggregate(cpumfs(im_Utilization with average as Value)))
  &$select=ID,Name,LocationDesc,Longitude,Latitude,PrimaryIPAddress
  &$filter=((length(LocationDesc) ne 0) and (groups/any(L1:L1/ID eq <id>)))
  &starttime=<startTime>&endtime=<endTime>
  &resolution=HOUR
  &$format=text/csv
  &top=500
```

Looks reasonable. Path rewritten, lambda added for `groups/`, parens added around groupby key. The script's job is done.

**Deploy attempt 1 → HTTP 500.** Response body contained the SQL the translator generated:

```sql
... WHERE (v_dim_item.is_device = 1) AND (v_dim_item.length(device_location_description) <> 0) ...
-- ERROR: Schema "v_dim_item" does not exist
```

The clue is `v_dim_item.length(device_location_description)` — `length` got compiled as a property/method access on `v_dim_item` rather than as a scalar function call. **The 4.0 translator doesn't recognize `length()`.** The Vertica "schema does not exist" error is misleading; the parser tripped on the malformed function call.

**Fix 1:** swap `length(LocationDesc) ne 0` → `LocationDesc ne null`.

**Deploy attempt 2 → HTTP 200, but zero devices.** Status banner shows the empty-result case. Two possibilities: either the group genuinely has no matching devices, or the filter is too aggressive.

**Diagnosis: build a candidate query in the OData Query Builder UI** (`/pc/odataquery`) without `LocationDesc` filter. Result: 50 devices returned, all with valid lat/long but **empty (not null) `LocationDesc`**. The `ne null` predicate wasn't matching empty strings.

**Fix 2:** swap `LocationDesc ne null` → `Latitude ne null` — semantically more correct anyway, since coordinates are what the map actually needs.

**Bonus discovery from the Query Builder:** the working query used a structurally different shape:

```
/pc/odata4/api/devices
  ?$select=ID,Name,PrimaryIPAddress,Latitude,Longitude,LocationDesc
  &$filter=(Latitude ne null)
  &$expand=cpumfs($apply=groupby((DeviceItemID),aggregate(im_Utilization with average as Value)))
  &resolution=RATE&period=4h
  &$format=text/csv
```

This puts the aggregation **inside `$expand`** instead of at the top level. Inside `$expand=cpumfs(...)`, the root is `cpumfs` itself, so `DeviceItemID` and `im_Utilization` are unqualified — matching the syntax we'd use if querying `/cpumfs` directly. This form is what the Query Builder UI generates and tends to be the cleanest pattern. See `odata-query-guide.md` "Choosing an aggregation form" for when each pattern is appropriate.

**Deploy attempt 3 → HTTP 200, 50 devices, working as expected.**

### Lessons from this example

1. **Don't trust the script's output blindly** — it handles syntactic conversion, not semantic gotchas like unrecognized function names.
2. **Read the SQL in the 500 response** — it tells you what the OData translator did with your query, which is more useful than the OData syntax alone.
3. **Use the Query Builder as ground truth** — when stuck, build a working query there first, then bring its structure into your code.
4. **Filter predicates that look equivalent may not be** — `length(X) ne 0`, `X ne null`, and `X ne ''` express subtly different intents and may behave differently against the same data.
5. **Iterative debug is the norm, not the exception.** Expect multiple deploy cycles when converting a non-trivial 2.0 query. Each one teaches you something concrete.
