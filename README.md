# Carbide App for Splunk

Lightweight data-source gap & latency monitor for Splunk. Detect when
hosts, sources or sourcetypes stop reporting; alert when they do. No
licence key, no external dependencies, no data-model accelerations
required.

## Quick start (5 minutes)

1. **Create the index.** Make an index named `carbide` (the app does
   not ship one). To use a different name, create it under your own name
   and point the `carbide_index` macro at it.
2. **Install** the app to `$SPLUNK_HOME/etc/apps/carbide_app_for_splunk/`
   and restart Splunk.
3. **Open** the app — you'll land on a 3-step Welcome page.
4. **Run the seed searches — before discovery.** In Settings > Searches,
   run *Carbide - Seed Entity Filters* (installs the default exclude
   rules: internal `_*` indexes, `summary`, `history`) and *Carbide -
   Seed Holidays* (pre-fills the holiday calendar). Both are idempotent
   and also run hourly on their own — but discovery run before the
   filter seed will inventory all the internal-index noise the rules
   exist to exclude. Seed first, discover second.
5. **Optionally configure** before discovering: **Manage > Entity
   Filters** to keep noisy axes out, and **Manage > Auto-watch rules**
   to auto-onboard matching entities the moment they're discovered.
6. **Run discovery once.** In Settings > Searches, run
   *Carbide - Discover hosts (recommended)* and
   *Carbide - Discover sourcetypes (recommended)* (they also run every
   4 hours on their own).
7. **Pick what to watch.** Open *Manage entities*, filter on what
   matters, click **Start watching** in the quick actions row — or rely
   on your auto-watch rules.
8. **Wait one cycle (5 min)** and refresh the Home page — health is
   live, alerts are armed. Wire alert actions in Settings > Searches
   on the alert saved searches (Hosts, Sources, Clusters) when you're
   ready.

That's it. Everything else below is reference. New to the operator
mental model? Open Home → Manage entities → Alerts. The Manage menu
holds auto-watch rules, assets, holidays, entity filters and threshold
suggestions; Trends, Availability and Settings sit alongside. Every entity name in
the app links to its entity page (status, config, history, last
events).

Carbide is deliberately small and opinionated:

- **Two tracking methods**: HOST entities (`index+host` / `host+source` /
  `host+sourcetype`) and SOURCE entities (`index+source` /
  `index+sourcetype`). Each entity has its own thresholds.
- **Three thresholds per entity**: `max_latency_seconds` (delay between
  `_time` and `_indextime`), `max_gap_seconds` (how long since the
  last event was generated), and opt-in `min_volume_pct` — alert when
  the 24h event count drops below N% of the entity's learned baseline
  (an EMA the snapshot maintains; catches sources that keep sending a
  trickle on time while most of the volume is lost). The baseline needs
  a day or two of history before volume alerts arm themselves.
- **Availability view**: per-entity heatmap (worst recorded state per
  day) plus dwell-based availability %% and total downtime over 7/30/90
  days — the management answer to "how reliable is this feed?".
- **Review queue with dismiss**: Home lists auto-discovered entities
  awaiting review; "Dismiss from review" (Manage entities) removes ones
  you deliberately won't watch, without deleting them.
- **Daily digest email** (fill in `action.email.to` on *Carbide - Daily
  digest*): every morning, one email listing everything currently
  missing, delayed, or below normal volume.
- **Stale-entity cleanup**: the Manage entities *Stale* filter surfaces
  entities silent for 30+ days; bulk *Stop tracking* removes them in
  one click. Optional disabled housekeeping searches automate it.
- **CSV export / import** on Manage entities and every rules page —
  back up, migrate, or bulk-edit in a spreadsheet; rows with `_key`
  update in place, rows without are created.
- **`tstats`-only**: discovery and live status calculation never scan
  raw events.
- **Inline + bulk editing**: cells in the Manage dashboards are
  click-to-edit. A bulk toolbar applies a value to every row in the
  current filter via a single KV `batch_save` call (one POST regardless
  of row count). Maintenance windows have `maintenance_from` /
  `maintenance_until` so you can also schedule a window for the future
  (`+15min` / `+1h` / `+1d` / ...).
- **Tags per entity** for ad-hoc grouping ("prod", "payments-team",
  "vendor:zscaler"). All dashboards filter on a case-insensitive
  "contains" match — same for the free-text entity search boxes.
  Quick actions add/remove a tag across a filtered or ticked selection,
  and set gap/latency thresholds in bulk the same way.
- **HA clusters (quorum monitoring)** — Manage > Clusters. A cluster is
  a tag plus a quorum rule: entities carrying the tag are members, and
  the cluster stays Healthy while at least `min_healthy_pct` % of its
  eligible members report (optional absolute floor for small pools).
  Snoozed / off-hours / settling / new members are excluded from the
  math on both sides; a member counts as reporting unless DOWN or
  CRITICAL. With `suppress_member_alerts` on (the default), one dead
  node in a redundant pool pages nobody and is hidden from Home while
  the cluster absorbs it — losing quorum fires the cluster alert with
  the full failing-member list, and members only page individually once
  the whole cluster is down. Cluster membership is flagged wherever
  entities render (🛡 tag chips + an "In clusters" row on the entity
  page).
- **Threshold suggestions** dashboard: 7-day P95 latency × 1.5 and
  average interval × 5 are proposed per entity; "Apply suggested ... to
  shown rows" pushes the proposals to every row currently shown in
  chunked batch writes.
- **Three alerts (Hosts, Sources, Clusters)**. Hosts and Sources fire on
  DOWN / LATE / CRITICAL / LOW_VOLUME; each ships a fixed notable
  `severity` (`high` for hosts, `medium` for sources — Splunk requires
  a literal enum value here, not a per-result token); ES then derives
  per-asset **urgency** from that severity and the asset's priority,
  and the RBA risk action + notable description carry the
  `asset_criticality` signal. The Clusters alert fires on DEGRADED /
  DOWN (quorum lost) and is deliberately email-only — quorum loss is an
  availability signal; the ES actions ride on the host alerts. ES
  notable + email actions ship pre-templated; fill in `action.email.to`
  to enable.
- **Settings → Audit trail** sources from Splunk's built-in
  `splunkd_access` log, so every KV write under the app is recorded
  automatically without any browser-side audit code.
- **Auto-watch rules**: when discovery finds a new entity matching a
  rule (scope + wildcard patterns on index/host/source/sourcetype),
  it's onboarded at insert time - watching enabled, schedule and
  gap/latency thresholds set, tags applied. First matching rule wins;
  rules are not retroactive; the entity's notes record which rule
  onboarded it. Manage > Auto-watch rules.
- **Scoped include/exclude rules** on any of
  `index` / `host` / `source` / `sourcetype`. Patterns support Splunk
  wildcards (`*`, `?`). A rule applies to everything, to one axis
  (hosts / sources), or to a **single discovery mode** — so two modes
  on the same axis can split the estate (e.g. track `index=netdev*`
  per source file via `index_source`, and everything else per
  sourcetype via `index_sourcetype`, with both discovery searches
  enabled at once). Default rules ship as a seed CSV that's preserved
  across upgrades.
- **Dedicated `carbide` index** for history & trending (name is
  configurable via the `carbide_index` macro; you create the index —
  the app does not ship an `indexes.conf`).
- **Change-only history**: snapshots only `| collect` an event when the
  status differs from the previously persisted state; KV writeback is
  also gated on (status changed OR `last_event_time` advanced). A
  cheap hourly heartbeat for non-OK entities keeps trending queries
  anchored.
- **Self-test panel** verifies every collection, the entity-filter
  macro, the dedicated index and the saved searches in one glance.
- **Alerts** for DOWN / LATE / CRITICAL / LOW_VOLUME ship with sensible
  per-entity suppression (30 min).

## Status model

| Status   | Meaning                                                           |
|----------|-------------------------------------------------------------------|
| OK        | Within both `max_gap_seconds` and `max_latency_seconds`.         |
| LATE      | Events still arriving but ingest latency exceeds `max_latency`.  |
| DOWN      | No events at all within `max_gap_seconds`.                       |
| CRITICAL  | Both LATE and DOWN — i.e. the trickle that does arrive is stale. |
| LOW_VOLUME | Events arrive on time but the 24h count fell below `min_volume_pct` % of the learned baseline (opt-in per entity). |
| SETTLING  | The entity's schedule (weekdays/business_hours) just reopened; DOWN/LATE are held for a grace window so a schedule-idle feed isn't flagged before it can send. |
| MAINT     | Snoozed by admin (`maintenance_until > now()`); alerts skip it.  |
| OFF_HOURS | Outside the entity's `monitoring_schedule` window; alerts skip.  |
| NEW       | Newly discovered and still within `carbide_grace_period`.        |

HA clusters have their own status vocabulary, derived from the cached
member statuses:

| Cluster status | Meaning                                                       |
|----------------|---------------------------------------------------------------|
| OK        | Quorum holds: enough eligible members report.                      |
| DEGRADED  | Quorum lost: below `min_healthy_pct` (or `min_healthy_count`).     |
| DOWN      | Zero eligible members reporting.                                   |
| IDLE      | Members exist but none are eligible (all snoozed / off-hours).     |
| EMPTY     | No monitored entity carries the cluster's tag (misconfiguration).  |

Home, Manage entities, and alerts all read from the cached path that the
snapshot saved searches keep within 5 minutes of live. For ad-hoc live
status (no staleness), run `` | `carbide_host_status` ``,
`` | `carbide_source_status` `` or `` | `carbide_cluster_status` ``
directly in the Search bar — same macros the snapshots use, just
dispatched on demand.

## Installation

```
$SPLUNK_HOME/etc/apps/carbide_app_for_splunk/
```

**The app does not ship an `indexes.conf`** — you must create the
`carbide` index yourself (an outage monitor shouldn't dictate your
indexing/retention policy, and in distributed deployments index
definitions belong on the indexer tier, not the search-head app).
Create an index named `carbide` (or any name, then point the
`carbide_index` macro at it) on the appropriate tier — on the indexers
in a distributed deployment, or locally on a standalone search head.
Example `indexes.conf` stanza:

```
[carbide]
homePath   = $SPLUNK_DB/carbide/db
coldPath   = $SPLUNK_DB/carbide/colddb
thawedPath = $SPLUNK_DB/carbide/thaweddb
# ~90 days is plenty; the index holds only transitions + hourly heartbeats
frozenTimePeriodInSecs = 7776000
```

Restart Splunk (KV-store collections register on first load). On the
search head, open the **Carbide App for Splunk** app and:

1. Optionally adjust the bootstrap defaults for newly discovered
   entities by editing the `carbide_default_*` search macros
   (Settings > Advanced search > Search macros — the app's Settings
   page documents each key).
2. Optionally open **Manage > Entity Filters** and add include/exclude
   rules. Defaults shipped via seed CSV exclude internal/summary/history
   indexes and summary-indexing artifacts.
3. Let the **Discover hosts (index_host)** and **Discover sourcetypes
   (index_sourcetype)** searches run once each (they're scheduled every
   4 hours and also runnable on demand from the Searches & Reports UI).
4. Open **Manage entities** and flip *Watching* on for the entities you
   actually want Carbide to watch. Use the bulk-action toolbar to do it
   for many at once.

## Scheduled monitoring (workweek / business hours / holidays)

Some sources don't need 24/7 watching — a backup-batch source that only
runs Monday-Friday during business hours shouldn't page anyone at 02:00
on a Sunday. Carbide lets each entity carry a `monitoring_schedule`
preset:

| Schedule          | Meaning                                                       |
|-------------------|---------------------------------------------------------------|
| `247`             | Always monitored (default for new entities).                  |
| `weekdays`        | Mon-Fri only. Weekends + holidays = `🌙 Off-hours`.          |
| `business_hours`  | Mon-Fri within `business_hours_start` / `business_hours_end`. Outside that window = `🌙 Off-hours`. |

Outside the active window the entity reports status `OFF_HOURS`. Alerts
(and the risk action they carry) and the hourly heartbeat all skip
OFF_HOURS rows. The snapshot saved searches still update the KV row's
`last_status` so the live view stays honest, but transitions into and
out of OFF_HOURS (and the `SETTLING` grace state below) are **not**
indexed — keeping the carbide index focused on real outages. A feed
that is genuinely broken when the schedule reopens still surfaces: it
sits in `SETTLING` for the grace window, then goes DOWN (which **is**
logged), so you don't miss real Monday-morning incidents.

**Monday-morning grace.** For `weekdays`/`business_hours` entities the
gap is wall-clock, so at the moment the schedule reopens the accumulated
off-hours time would otherwise trip a `max_gap` threshold immediately (a
Friday-to-Monday feed looks "quiet for 2+ days"). Instead the entity
enters `SETTLING` for a grace window after the schedule reopens: if
fresh data arrives it clears to healthy, and only if it stays silent
past the grace does it go DOWN. The grace is
`carbide_default_offhours_grace` (default 1h), overridable per entity
via the **Grace after reopen** field (0/blank = the global default).

Set the per-entity schedule via the **Schedule** column in
*Manage entities* (dropdown). Use the quick-action toolbar to apply
`📅 24/7` / `📅 Weekdays` / `📅 Business hrs` to every row matching the
current filter.

Configure the global business-hours window via the `carbide_default_*`
search macros (Settings > Advanced search > Search macros):

- `carbide_default_business_hours_start` — HHMM as a number, default `800`.
- `carbide_default_business_hours_end` — HHMM as a number, default `1600`.
- `carbide_default_monitoring_schedule` — the preset newly discovered
  entities receive (default `"247"`, quotes required).

**Timezone**: Splunk's `strftime` doesn't accept a timezone argument, so
all weekend / business-hours / holiday checks run in the dispatching
user's tz preference (which defaults to the search head's server tz for
scheduled searches). If you need a specific tz, set it globally via
`server.conf` `[general]` on the search head — there is no per-app tz
override available in Splunk.

Manage the global holiday list at **Manage holidays**. Two date formats
are supported in the same `date` column:

- `YYYY-MM-DD` with `recurring=0` — applies only to that specific year.
- `MM-DD` with `recurring=1` — applies every year on that month/day.

Empty holiday list = no holidays, the schedule only respects weekends
plus business hours. The list is global; if your SOC straddles regions
with different calendars, populate the union and use per-entity `tags`
to differentiate (the tag filter still works inside an OFF_HOURS
window).

## Maintenance windows

Click the **Snooze from** or **Snoozed until** cell on any row in
*Manage entities* and pick a duration (`off`, `+15 min`, `+1 hour`, ...,
`+1 week`) — or use the **🔧 Snooze 1h / 1d / End snooze** quick-action
buttons to snooze every filtered (or checked) row at once. A window is
active when
`coalesce(maintenance_from,0) <= now() AND maintenance_until > now()` —
leave `maintenance_from` at `0` (the default) for "starts immediately",
or set it to a future time to schedule a window ahead. The status macro
reports the entity as `MAINT` for the duration; alerts skip MAINT rows
automatically. Every entity page also has one-click snooze controls.

## Tracking modes

Discovery searches for the non-default tracking modes ship `disabled=1`.
Enable any of them from **Settings > Searches** when you need that axis:

- `Carbide - Discover hosts (advanced: host and sourcetype)` — catches a
  single sourcetype going quiet while the host keeps logging everything
  else. More granular, more entities.
- `Carbide - Discover hosts (advanced: host and source)` — per file path.
- `Carbide - Discover sources (advanced: index and source)` — per file
  path within an index.

Default-enabled:

- `Carbide - Discover hosts (recommended)` — `index_host`: alerts when a
  host stops reporting into an index.
- `Carbide - Discover sourcetypes (recommended)` — `index_sourcetype`:
  alerts when a sourcetype stops arriving in an index.

`index_host` and `index_sourcetype` are the recommended primary modes
for most deployments. The status macro fans every live tstats row out to
all possible entity-key shapes, so opting into the other modes is mostly
a configuration step — but it also triples the per-row fan-out during
the mvexpand stage, which matters on very large fleets. If you only ever
use `index_host`, you can shave the fan-out by editing
`carbide_host_status` (Settings > Search macros) and removing `ek_hs`
and `ek_hst` from the `mvappend` line.

## What runs out of the box

| Saved search                                       | Schedule    | Default |
|----------------------------------------------------|-------------|---------|
| Carbide - Seed Entity Filters                      | hourly      | on      |
| Carbide - Seed Holidays                            | hourly      | on      |
| Carbide - Discover hosts (recommended)             | every 4 h   | on      |
| Carbide - Discover sourcetypes (recommended)       | every 4 h   | on      |
| Carbide - Status Snapshot: Hosts                   | every 5 min | on      |
| Carbide - Status Snapshot: Sources                 | every 5 min | on      |
| Carbide - Status Snapshot: Clusters                | every 5 min | on      |
| Carbide - Heartbeat: Non-OK entities               | hourly      | on      |
| Carbide - Alert: Hosts                             | every 5 min | on      |
| Carbide - Alert: Sources                           | every 5 min | on      |
| Carbide - Alert: Clusters                          | every 5 min | on      |
| Carbide - Daily digest: entities needing attention | daily 06:30 | on      |

Shipped **disabled** — enable from Settings > Searches when you want
them: the three advanced discovery modes (host+sourcetype, host+source,
index+source), the two stale-entity housekeeping searches, and
*Carbide - Sync ES asset_lookup_by_str to carbide_assets*.

The **Seed Entity Filters** search is idempotent: it reads the read-only
CSV at `lookups/carbide_entity_filters_seed.csv` and
inserts its rows into `carbide_entity_filters` **only when the
collection is empty** — so admin customizations survive app upgrades.
(The same pattern seeds `carbide_holidays` from
`lookups/carbide_holidays_seed.csv`.) On a fresh install, **run the two
seed searches before running discovery manually** — the exclude rules
have to exist before discovery for them to do their job.

The three snapshot searches are staggered (Hosts at minute 0, Sources at
1, Clusters at 2 of each 5-minute cycle) so the cluster snapshot always
reads member statuses the entity snapshots just refreshed.

The **Status Snapshot** searches now write to KV only when status
changed or `last_event_time` advanced, and emit an event to the carbide
index only when status changed. Steady-state windows produce zero KV
writes and zero indexed events. Each transition event records both
`status` and `previous_status`. The **Heartbeat** search emits one event
per hour for every entity still in a non-OK state so that window-bounded
trend queries always have an anchor point.

## How latency / gap are computed

For each tracked entity over `carbide_status_window` (default `-24h@h`):

```spl
| tstats max(_time) as last_event_time,
         latest(_indextime) as latest_indextime,
         count
  where `carbide_entity_filter("hosts")` AND index!=`carbide_index`
        AND [ <monitored entities from the KV store, via | format> ]
        earliest=`carbide_status_window`
  by index, host, sourcetype, source
```

then:

- `last_event_time` falls back to the value persisted in the KV row when
  the window has no events, so a gap **longer** than the 24h window
  (e.g. a weekly feed with a multi-day `max_gap`) is still measured
  correctly rather than read as a false DOWN. The fallback has one hard
  limit: if a feed's **ingest lag** exceeds the window, its events
  arrive already too old for the tstats to ever see, and the persisted
  last-seen time can never advance. For that reason the Manage UI
  refuses a `max_latency_seconds` above the window — if you need to
  tolerate more latency, widen `carbide_status_window` first (e.g.
  `-72h@h`); the UI limit follows the macro automatically.
- `current_gap`     = `now() - last_event_time`
- `current_latency` = `latest_indextime - last_event_time` — the ingest
  delay of the **most recent event**. (tstats only allows
  count/min/max/range/earliest/latest on time fields, so window-wide
  latency averages aren't possible — and latest-event delay is the more
  alert-relevant measure anyway.)
- `status`          = `case(...)` as per the Status model above

The embedded subsearch restricts the tstats to the entities you actually
monitor, so indexer cost scales with your watch list — not with the size
of the estate. With nothing monitored the tstats matches nothing.
Discovery searches group by only the fields their tracking mode needs
(never `source` unless you enable a source-path mode) and run every four
hours; run them manually from Settings › Searches when onboarding.

The status macros merge KV-side configuration with live tstats results
through `inputlookup ... | append [tstats ...] | stats by entity_key` —
no `join`, no 50,000-row truncation cap.

## KV-store collections

| Collection                | Purpose                                    |
|---------------------------|--------------------------------------------|
| `carbide_tracked_hosts`   | One row per tracked host entity.           |
| `carbide_tracked_sources` | One row per tracked source / sourcetype.   |
| `carbide_entity_filters`  | Per-field/per-scope include/exclude rules. |
| `carbide_autowatch_rules` | Auto-onboarding rules applied at discovery.|
| `carbide_assets`          | Per-host criticality / owner / BU.         |
| `carbide_holidays`        | Holiday calendar for OFF_HOURS checks.     |
| `carbide_clusters`        | HA groups: quorum rules keyed by member tag.|

Bootstrap defaults (thresholds, schedule, monitored flag for newly
discovered entities) live in the `carbide_default_*` search macros —
see the Settings dashboard for the list.

Long-term trending is shipped to `` index=`carbide_index` `` (default
`carbide`) with `sourcetype="carbide:status"`. Inline-edit auditing
comes from Splunk's built-in `splunkd_access` log (see Settings >
Audit trail) — no app-side audit events.

To change the destination index name:

1. Edit the `carbide_index` macro (Settings > Advanced search > Search
   macros) to the new name.
2. Make sure an index with that name exists on the relevant tier
   (indexers, or a standalone search head) — the app does not create it.
3. Restart Splunk.

## Splunk Enterprise Security integration

Carbide ships ES integration in four pieces. Notable events, CIM
alignment, and risk-based alerting are **always on** and silently no-op
without ES. Asset enrichment works with or without ES — populate it
manually, or enable the optional ES-sync search.

### 1. Notable events (no-op without ES)
Both alerts (`Carbide - Alert: Hosts`, `Carbide - Alert: Sources`) carry
`actions = notable,email`. On installs with ES, each match becomes a
notable event in Incident Review. `severity` is a fixed literal per
alert (`high` for hosts, `medium` for sources) — Splunk validates this
param against the enum `informational|low|medium|high|critical|unknown`
at config time and rejects a per-result token, so it cannot be derived
per result. ES computes each notable's **urgency** from that severity
and the affected asset's priority (asset framework), so criticality
still shapes prioritisation; the RBA risk action and the notable
description also carry `asset_criticality`. Change the literal in the
alert if `high`/`medium` don't match your severity scheme. On installs
without ES, the notable action logs a warning and is skipped — the rest
of the alert (including email) is unaffected.

### 2. CIM `Alerts` data model alignment (always on)
`default/props.conf` ships `FIELDALIAS-cim_*` + `EVAL-*` for the
`carbide:status` sourcetype that map `entity_key` → `dest`, derive
CIM `severity` / `severity_id` / `type` from `status`, and stamp
`app` / `vendor_product`. `eventtypes.conf` defines a `carbide_cim_alert`
eventtype; `tags.conf` tags it with `alert`. Any CIM-aware search
(`tag=alert`, ES Alerts dashboards, generic correlation searches)
sees Carbide events out of the box.

### 3. Asset enrichment (works without ES)
The host status macro does
```spl
| lookup carbide_assets_lookup host OUTPUTNEW
    criticality   AS asset_criticality,
    owner         AS asset_owner,
    business_unit AS asset_bu
```
Populate `carbide_assets` from **Manage > Manage assets** (the dashboard
ships with the app) by adding rows manually, OR enable the optional
*Carbide - Sync ES asset_lookup_by_str to carbide_assets* saved search
if you have ES + a populated asset framework. Empty collection = no
enrichment, no errors — the lookup is a best-effort join.

### 4. Risk-based alerting
*Carbide - Alert: Hosts* carries the ES `risk` adaptive response
action (`action.risk`): every firing adds a risk event for the
affected host (`risk_object_type=system`, base `risk_score=20`,
message includes entity, status and gap). Tune the base score in the
alert (UI or `local/savedsearches.conf`); use **ES Risk Factors** to
scale it by asset priority, category, etc. Without ES the action is a
no-op, same as the notable action.

## Search-head clustering

Carbide is SHC-safe out of the box. The pieces that usually bite
clustered-search-head apps are handled:

- Every KV-store collection in `default/collections.conf` carries
  `replicate = true`, so the collections replicate automatically.
- Every saved search has `dispatchAs = owner`, and
  `metadata/default.meta` pins `[savedsearches] owner = nobody`, so
  scheduled searches always dispatch as the same logical owner across
  captain failovers.
- All config ships under `default/`. Nothing is written to `local/` on
  any individual member at runtime - which means the deployer bundle is
  the only source of truth and members never drift.
- Inline edits, bulk `batch_save` calls, snapshot writebacks, and
  discovery inserts are all idempotent (`outputlookup key_field=_key`
  upserts; the seed search no-ops on a non-empty collection). A
  duplicate dispatch during captain failover rewrites the same row
  instead of corrupting state.
- The perf pass eliminated 4 redundant `tstats` invocations per
  5-minute cycle (alerts now read the cached KV row) and staggered the
  remaining schedules. The captain isn't a bottleneck.

### Install on SHC

Deploy through the SHC deployer, not by copying to one search head:

```
cp -r carbide_app_for_splunk \
  $SPLUNK_HOME/etc/shcluster/apps/
splunk apply shcluster-bundle \
  -target https://<sh-captain>:8089 -auth admin:<pwd>
```

The bundle replicates `default/` to every member.

Create the `carbide` index on the indexer tier separately (index
definitions are only honored by indexers, and the app doesn't ship one
— see Installation). For a clustered indexer tier, deploy the index
definition via the cluster manager.

### Operating notes on SHC

- **Replication lag**: cached reads on a non-captain SH may trail the
  captain by a few seconds immediately after a snapshot writeback.
  Effectively bounded by MongoDB replication lag; sub-second to a few
  seconds on healthy clusters. Inline-edit then refresh on the same
  SH always reflects its own write (read-your-own-writes per node).
- **Brief captain-change windows** may miss one `*/5` cycle. The next
  run reads the previous state from KV and proceeds. No catch-up is
  needed.
- **Suppression state**: `alert.suppress.fields = entity_key` state is
  captain-local but transferred during failover. Worst case after a
  captain change: one duplicate alert. Acceptable for a data-source
  outage channel.
- **Don't put Carbide files in `local/`** on individual SHs. The
  app's "deploy once, replicate everywhere" model relies on every
  member running the same bundle.

## Roles / permissions

Read access is granted to all users; write access (KV stores, lookups,
saved searches) is restricted to `admin`, `power`, `sc_admin`. Inline
editing in the Manage views is enforced server-side via the same
capabilities — non-admin users see read-only tables.

## Files

```
carbide_app_for_splunk/
├── app.manifest               Splunkbase metadata
├── default/
│   ├── app.conf
│   ├── collections.conf       7 KV-store collections
│   ├── transforms.conf        Lookup definitions (KV + seed CSV)
│   ├── macros.conf            tstats discovery + status + helpers
│   ├── savedsearches.conf     Seed, discovery, snapshots, heartbeat,
│   │                          alerts, daily digest, housekeeping, ES sync
│   ├── eventtypes.conf        carbide_cim_alert (CIM tag=alert)
│   ├── tags.conf
│   ├── props.conf             carbide:status sourcetype parsing + CIM
│   ├── workflow_actions.conf  "Open in Carbide" field action on entity_key
│   │                          (NOTE: no indexes.conf - you create the index)
│   └── data/ui/
│       ├── nav/default.xml
│       └── views/
│           ├── home.xml               SimpleXML dashboard
│           ├── trends.xml             SimpleXML dashboard
│           ├── alerts.xml             SimpleXML dashboard
│           ├── settings.xml           SimpleXML dashboard
│           ├── manage_entities.xml    These 9 views are thin SimpleXML
│           ├── manage_clusters.xml    shells (Splunk header + nav) that
│           ├── manage_autowatch.xml   each host one <html> panel which
│           ├── manage_assets.xml      carbide_manage.js renders from the
│           ├── manage_holidays.xml    KV REST API (data-page routing)
│           ├── manage_entity_filters.xml
│           ├── manage_suggestions.xml
│           ├── availability.xml       heatmap + uptime % (JS-rendered)
│           └── entity.xml             per-entity drilldown (JS-rendered)
├── lookups/
│   ├── carbide_entity_filters_seed.csv
│   └── carbide_holidays_seed.csv
├── appserver/static/
│   ├── carbide_manage.js          All JS-rendered pages: KV REST client,
│   │                              tables, inline editing, bulk actions,
│   │                              CSV, entity page, availability
│   ├── carbide_manage.css         Dark styling for the JS pages
│   └── carbide.css                Styling for the SimpleXML dashboards
├── static/                        App-branding icons (launcher/nav) -
│   ├── appIcon.png / _2x          MUST live here, not appserver/static/
│   ├── appIconAlt.png / _2x
│   ├── appLogo.png / _2x
│   ├── carbide-512.png            master artwork
│   └── README_icons.txt
├── metadata/default.meta
├── README.md
├── README.txt
└── LICENSE
```
