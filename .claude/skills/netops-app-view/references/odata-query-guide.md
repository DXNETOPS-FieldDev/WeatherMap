# OData Query Guide

This file covers the OData query syntax you'll need to read existing App Views and construct queries for new ones. Companion file `odata-query-examples.md` has a catalog of full example queries by use case.

## Request paths

App Views use the NetOps Portal proxy. Always use relative paths starting with `/pc/`:

- **OData 4.0** (preferred for new builds): `/pc/odata4/api/<entityset>?...`
- **OData 2.0** (older apps): `/pc/odata/api/<entityset>?...`

The portal proxies these to the data aggregator and inherits the user's session for authentication. Never include hostname, scheme, or port.

To inspect a deployment's full entity schema in a browser:
- OData 4.0 metadata: `/pc/odata4/api/$metadata`
- OData 2.0 metadata: `/pc/odata/api/$metadata`

## Entity sets you'll see most often

Inventory entities:
- `devices`, `interfaces`, `cpus`, `components`, `groups`, `servers`, `routers`

Metric families (time-series tables — names end in `mfs`):
- `portmfs` (interface metrics)
- `cpumfs` (CPU metrics)
- `availabilitymfs`, `reachabilitymfs`
- `devicepollingstatisticsmfs`
- `sdntunnelmfs`, `virtualinterfacemfs`

Alarms (25.4.5+):
- `activealarms`, `raisedalarms`, `clearedalarms`

Baselines (25.4.5+) — append `dailybaselines` or `hourlybaselines` to metric family roots:
- `cpumfdailybaselines`, `portmfhourlybaselines`

Flow data (25.4.7+):
- `flowdevices`, `flowinboundinterfaces`, `flowoutboundinterfaces`, `flowapplications`
- `flowconversationmfs` (the flow time-series metric family)

### Metric family naming convention

OData metric family names are shortened internal names. The transformation:
1. Drop the `Normalized` prefix
2. Drop the `Info` suffix
3. Lowercase
4. Append `mf`

`NormalizedPortInfo` → `portmf`. The entity set is the plural: `portmfs`.

## OData 4.0 tokens

The QueryBuilder UI tokens map onto URL parameters as follows:

| Picker / token | URL parameter | Purpose |
|---|---|---|
| `for` | path segment (entity set in URL) | Root entity of the query |
| `select` | `$select` | Pick which columns to return |
| `filter` | `$filter` | Apply predicates |
| `expand` | `$expand` | Inline related entities |
| `expand metrics` | `$expand` on a metric family | Inline time-series data |
| `group/aggregate` | `$apply` | Aggregation, grouping |
| `filter metrics` | `$filter` on an aggregated alias | Post-aggregation filter |
| `time range` | `period`, `starttime`, `endtime`, `resolution` | Temporal scope and granularity |
| `limit (top)` | `$top`, `$skip` | Paging and result cap |
| `sort` | `$orderby` | Result ordering |
| `format` | `$format` (or `Accept` header) | Response format (JSON, XML, CSV) |
| `custom parameter` | arbitrary `&key=value` | Override defaults (`timeout`, `priority`, etc.) |

### `$filter` essentials

Operators: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`

String functions: `contains(field, 'x')`, `startswith(field, 'x')`, `endswith(field, 'x')`

Collection quantifiers (for navigation properties):
- `groups/any(s: s/Name eq 'Routers')` — at least one related group named 'Routers'
- `cpumfs/all(s: s/im_Utilization gt 80)` — every CPU's utilization exceeds 80

Count predicate (25.4.6+):
- `activealarms/$count gt 0` — has at least one active alarm

### `$expand` essentials

Pulls in related entities. Supports nested `$select`, `$filter`, `$top`, `$count`, and `$apply`:

```
$expand=cpus($select=Name; $expand=cpumfs($select=ID,Timestamp; $top=30))
```

Keep nesting to 2–3 levels max for performance.

### `$apply` (aggregation pipeline)

The 4.0 aggregation extension. Chains transformations with `/`:

```
$apply=filter(Bytes gt 0)/groupby((DeviceItemID), aggregate(Bytes with sum as sumBytes))/filter(sumBytes gt 1000000)
```

Common shapes:
- `groupby((Key1,Key2), aggregate(field with sum as alias))`
- `aggregate(field with average as alias)` (no grouping; collapses to one row)
- `aggregate($count as recordCount)` (count rows)

Aggregate functions: `sum`, `average`, `min`, `max`, `countdistinct`, `f.percentile80`, `f.percentile95`, `f.percentile98`, `f.percentile99`. Special functions: `projection`, `timetothreshold`, `slope`, `intercept`, `datasetcount`.

**Alias naming rules** (the picker enforces them):
- Pattern: `^[A-Za-z][A-Za-z0-9_]*$`
- Unique within the query

**Use meaningful aliases** like `sumBytes`, `avgUtilization`, `p95Util` — not the generic `Value`. Post-aggregation `filter()` and `$orderby` reference aliases, so generic names make chained pipelines ambiguous.

### Time range parameters

- `resolution=RATE` — as-polled raw values (the default)
- `resolution=HOUR` — hourly rollups
- `resolution=DAY` — daily rollups
- `resolution=WEEK` — weekly rollups

- `period=1h` / `period=1d` / `period=1w` / `period=1m` / `period=1y` — relative time window from now, human-time (respects DST)
- `duration=1w` / `duration=24h` — machine-time window (ignores DST)
- `starttime=<epoch_seconds>` and `endtime=<epoch_seconds>` — absolute window
- `tz=-05:00` — timezone offset from GMT (ignored for daily/weekly resolution)
- `bh=Mon-Fri 9:00-17:00` — business hours filter (multiple ranges allowed with commas)

### Other useful overrides

- `&$top=200` — override the default row limit (default 50)
- `&top=720` — override the default expanded-row limit per `$expand` (default 100)
- `&timeout=60` — override query timeout in seconds (default 30, max 120)
- `&precision=4` — decimal places for metric values (default 10, valid 2–12)
- `&$count=true` — include `@odata.count` in the response
- `/<entityset>/$count` — endpoint variant: return only the count, not the rows

## Choosing an aggregation form

When you need "one aggregated metric value per inventory item" (e.g. avg CPU per device, max utilization per interface), OData 4.0 has three structurally different shapes that produce the same data. Picking the right one matters for both clarity and reliability.

### Three valid shapes

**Form A — root entity = inventory, top-level `$apply`:**

```
/pc/odata4/api/devices?$apply=groupby((cpumfs/DeviceItemID),aggregate(cpumfs(im_Utilization with average as Value)))&$select=ID,Name
```

The aggregation is the top-level transformation. Property paths reach into `cpumfs` via the navigation property (`cpumfs/...`, `cpumfs(...)`).

**Form B — root entity = metric family, no expand needed:**

```
/pc/odata4/api/cpumfs?$apply=groupby((DeviceItemID),aggregate(im_Utilization with average as Value))
```

The root is the metric family itself. `DeviceItemID` and `im_Utilization` are unqualified because they're properties of the root. To get device names or other inventory fields, you'd add `$expand=device($select=Name,...)`.

**Form C — root entity = inventory, aggregation inside `$expand`:**

```
/pc/odata4/api/devices?$select=ID,Name,Latitude,Longitude&$expand=cpumfs($apply=groupby((DeviceItemID),aggregate(im_Utilization with average as Value)))
```

The aggregation lives inside the `$expand` clause. Inside `$expand=cpumfs(...)`, the root for nested expressions is `cpumfs` itself — so the aggregation syntax uses unqualified property names, just like Form B. But the outer query is still rooted at `devices`, so `$select`/`$filter` operate on device properties.

### When to use which

- **Form A** when the natural top-level shape is "devices, grouped by some metric dimension" and you don't need many inventory properties in the result. Compact but the property-path quoting (`cpumfs(im_Utilization ...)`) can be quirky in some server implementations.

- **Form B** when the aggregation is the focus and inventory data is supplementary. Cleanest aggregation syntax. Requires `$expand` back to inventory for any device properties you need in the result.

- **Form C** for the common "list of inventory items, each annotated with one aggregated metric value" use case. This is what the portal's Query Builder UI tends to generate, and is usually the most reliable shape — the OData server translates it cleanly. Recommended default.

### Form-vs-root rule

Inside `$expand=X(...)` or `$apply=...(X(...))`, the root for the nested expression is `X` itself. So:
- `groupby((cpumfs/DeviceItemID), ...)` is correct outside an expand (need to navigate to `cpumfs`)
- `groupby((DeviceItemID), ...)` is correct inside `$expand=cpumfs(...)` (already rooted at `cpumfs`)

Mixing these up — using a qualified path inside an expand, or an unqualified path outside one — is one of the most common 4.0 syntax mistakes when hand-writing queries. If the server returns a property-not-found error referencing a column name without an entity prefix, this is usually the cause.

## Use the OData Query Builder UI as ground truth

The portal includes a Query Builder UI at `/pc/odataquery` that's underused. It's the single fastest way to validate whether a query shape is correct before integrating it into application code.

### Why this matters

When debugging a misbehaving query, two questions get conflated:
- Is the OData server happy with this query?
- Is my application code parsing the response correctly?

The Query Builder separates them. It runs against the same OData endpoint your app uses, with the same authentication, and shows the raw response. If the query works there, the bug is in your code. If it doesn't, the bug is in the query.

### Suggested workflow

1. **For new queries**: build the query interactively in the Query Builder using the picker UI. The generated URL is shown at the top — copy it once it returns the data you expect.
2. **For failing queries**: paste the URL you're using in your app into the Query Builder's URL field (or a browser tab while logged in) and run it directly. Compare the response to what your code expects.
3. **For conversion work**: when converting an OData 2.0 query to 4.0, build the 4.0 candidate in the Query Builder first. The UI's pickers won't let you express invalid syntax, which catches a lot of subtle gotchas the conversion script can't.

### What the Query Builder will and won't tell you

It will:
- Confirm the query is syntactically valid 4.0
- Show the exact CSV/JSON shape the server returns
- Surface server errors with full detail (more than the app's status banner usually shows)
- Reveal column naming conventions (especially for aggregated metric paths)

It won't:
- Tell you whether your filter logic matches what's actually in the database (you might filter to zero rows by accident — that's a "build it and see" situation)
- Replicate the URL parameter substitution the portal does for App Views (`{ItemIdDA}` etc. — you fill in concrete values in the Builder)
- Match every URL parameter format your app uses (the Builder doesn't expose every override the API accepts)

## OData 2.0 differences (for reading legacy apps only)

**OData 2.0 is no longer supported by DX NetOps Performance Management.** The information below is for *reading and understanding* legacy App View code in preparation for converting it — not for writing new queries. All 2.0 queries must be converted to 4.0 before reuse. Conversion is done by an external script the user invokes (`convertToOdata4_patched.py`); see `odata-2-to-4.md` for the handoff protocol.

OData 2.0 looks similar to 4.0 but has these recognizable distinctions:

- Path: `/pc/odata/api/` (no "4")
- String functions: `substringof('x', field)` instead of `contains(field, 'x')`
- Aggregation: `$apply=groupby(<keys>, aggregate(<expr> with <fn> as <alias>))` — similar syntax, slightly different semantics. Aggregated values reported in a column named `Value` by default.
- No `$count` endpoint or `$count` annotation; counts are derived in code.
- No multi-property `groupby` with nested grouping inside `$apply`.
- Function calls: bare path, no parens — `/getDataAggregators` (2.0) vs `/getDataAggregators()` (4.0).
- Navigation property filters do **not** use lambda syntax: `groups/Name eq 'X'` (2.0) vs `groups/any(s: s/Name eq 'X')` (4.0).
- Aggregation function names lack the `f.` prefix: `percentile95` (2.0) vs `f.percentile95` (4.0).
- `projection` and `timetothreshold` take their parameters as separate query-string variables (`prjoffset=...`, `threshold=...`) in 2.0, but bake them into the function name in 4.0 (`f.projection86400`, `f.timetothreshold40`).

These are the same patterns the conversion script keys off of. When you see them, route to the script handoff in `odata-2-to-4.md` rather than trying to interpret or hand-convert the query.

## Performance pitfalls to flag

These come up enough in the PDF best-practices section that a skill-aware Claude should mention them when writing or reviewing queries:

1. **Group filters use IDs, not names.** `groups/any(s: s/ID eq 42)` is faster and safer than `groups/any(s: s/Name eq 'Routers')` because names can change and string comparison is slower.

2. **Place the most-limiting filter first.** OData evaluates filters in URL order. Put the predicate that drops the most data at the front.

3. **Filter adjacent rules on the same object.** When multiple filters apply to the same entity, keep them together in the `$filter` string; splitting them reduces query efficiency.

4. **Don't mix group expressions with non-group expressions via `or`.** `(groups/any(...)) or (contains(Description, 'x'))` produces wrong results. Use `and`, or restructure.

5. **Pick the coarsest granularity that answers the question.** For metrics that aggregate by sum (like bits in/out), daily resolution gives the same totals as rate but runs far faster.

6. **Limit `$expand` depth to 2–3 levels.** Deeper expansion is allowed but performance degrades sharply.

7. **Use `$top` inside `$expand`.** Without it, every parent row pulls up to `defaultExpandTopLimit` (100) children, which adds up fast.

8. **Order by alias after `$apply`.** After aggregation, raw column names are gone — only group-by keys and aggregate aliases remain. `$orderby=Value` works only if you aliased an aggregate as `Value`; prefer meaningful aliases like `$orderby=sumBytes desc`.
