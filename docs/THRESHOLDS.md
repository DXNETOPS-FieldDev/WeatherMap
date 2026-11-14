# WeatherMap Thresholds: install and setup

**NetOps WeatherMap (Thresholds)** is a variant of WeatherMap that colors the map from **Performance
Management threshold alarms only**, and shows bandwidth **per ISP / external WAN circuit** rather than as a
device-wide average. It installs as its own App View, next to the standard WeatherMap, and doesn't change it.

| | Standard WeatherMap | WeatherMap Thresholds |
|---|---|---|
| Marker colors from | Spectrum alarms | Open threshold alarms in Performance Center |
| Needs Spectrum | for colors | **no** |
| Metrics tab | device metrics | Availability, and each WAN circuit's In / Out utilization |
| App View name / folder | NetOps WeatherMap / `WeatherMap` | NetOps WeatherMap (Thresholds) / `WeatherMapThresholds` |

## How it works

- **Colors.** Each marker takes the worst open threshold alarm on the device or any of its interfaces:
  **red** = Critical, **orange** = Major, **yellow** = Minor, **green** = none. A cluster takes its worst
  device's color. **Grey** means the alarms couldn't be loaded for that device; it is never shown as green.
- **Severity checkboxes.** The **Network** menu has *Critical alarms*, *Major alarms* and *Minor alarms*, each with
  its device count. Only ticked severities color the map. Critical and Major start ticked; the ticks reset when
  the page reloads.
- **Alarms tab.** Lists the device's open threshold alarms with the rule, the measured maximum and the start time.
  Each alarm opens its interface's page in the Portal, and **Investigate in Triage View →** opens the device's
  Triage View (when `triageViewPageId` is set).
- **WAN circuits.** One **interface group** in Performance Center drives both the alerts and the map:
  1. Apply your bandwidth threshold profile **to that group**, so bandwidth alarms come only from WAN circuits.
  2. Set `metrics.wanGroup` to that group. Each device's Metrics tab then lists its members, one line per
     circuit, busiest first, with its alias, In / Out utilization and speed.

  A device with no circuits in the group shows *WAN circuits: none on this device*.

## Install

1. **Allow WeatherMap's file types** on the Portal, if you haven't already for the standard WeatherMap. It's
   the same one-time setting: see the README's *Install → Step 1*.
2. **Upload `WeatherMapThresholds.zip`** (we send it to you) in **Administration → Configuration Settings → App
   Deployment**. It installs into `<PC_HOME>/PC/webapps/pc/apps/user/WeatherMapThresholds/`.
3. **Backends.** Colors and metrics come from Performance Center, so no backend setup is needed for them.
   Run `bash setup.sh` in that folder only if you also want Spectrum or NCM data in the popups (see the README's
   *Configure*). AppNeta paths are off in this variant.
4. **Add the App View to a dashboard**, as for the standard WeatherMap, and point it at the group of devices to
   show.

## Set up the interface group and the profile

1. **Create an interface group** in Performance Center holding your ISP / external WAN circuits. Consistent
   aliases or descriptions (for example "ISP", a carrier name or a circuit ID) make them easy to find.
2. **Apply your BW Utilization threshold profile to that group**, and **remove it from the device groups** it is
   on today.
3. **Clear the old alarms once, right after the move.** Alarms that the old placement already raised **stay open**
   after a profile is removed, because nothing re-evaluates them. Until they're cleared in the Alarm Console,
   campus devices stay red or orange for bandwidth.

Every threshold profile applied to a device still colors it (for example Errors or Discards profiles). You
decide what colors the map by deciding where the profiles are applied.

## Settings (`runtime-config.json`)

The file is in the App View's folder, owned by root. Edit it as root.

| Setting | Set it to | What it does |
|---|---|---|
| `metrics.wanGroup` | the interface group's **exact name** (in quotes), or its **group ID** (a number) | Turns on the WAN circuits view. A name must match exactly one group |
| `triageViewPageId` | **your** Portal's Topology page ID: open Topology in the Portal and copy the number after `pg=` in the address | The **Investigate in Triage View →** link and the topology icon. Shipped empty on purpose, because page IDs differ between Portals |
| `alarms.severities` | `["Critical","Major"]` (default) | Which severities start ticked |
| `alarms.refreshIntervalMs` | `60000` (default) | How often alarms are re-read, in milliseconds |

Set the first two with these one-line commands (replace the example values), run in the App View's folder:

```bash
sudo sed -i 's/"wanGroup": null/"wanGroup": "WAN Circuits"/' runtime-config.json
sudo sed -i 's/"triageViewPageId": null/"triageViewPageId": 1234567/' runtime-config.json
```

Each one changes one line. If a command changes nothing, the value was already set: open the file and edit it
there. No restart is needed; reload the map.

**After every upgrade of the App View, set them again.** Uploading a new zip with "Replace existing apps" resets
`runtime-config.json` to the shipped defaults.

## Check it works

1. Open the dashboard. The banner shows a purple **THRESHOLDS** tag and the device count.
2. Markers with open Critical or Major threshold alarms are red or orange. There are no lasting grey markers.
3. A device with WAN circuits → **Metrics** tab → **WAN circuits**, one line per circuit.
4. A device with alarms → **Alarms** tab → **Investigate in Triage View →** opens its Triage View.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Metrics shows *Bandwidth In / Out*, not *WAN circuits* | `metrics.wanGroup` is empty (often after an upgrade). Set it again |
| *WAN circuits could not be loaded* | The group name doesn't match exactly one group (renamed, deleted or duplicated). Check the name in Performance Center, or use the group ID |
| No *Investigate in Triage View →* | `triageViewPageId` is empty. Set it again |
| Campus devices red for bandwidth | Alarms left over from before the profile moved. Clear them in the Alarm Console |
| A circuit says *no sample in the last 15 minutes* | That interface isn't reporting. It's shown, not hidden, so you can see it |
| Grey markers that stay grey | Alarms couldn't be loaded. Wait for the next refresh (60 s), then reload the page |
| Fewer devices than the group has | Devices without map coordinates aren't shown, and neither are SD-WAN controllers, as in the standard WeatherMap |
