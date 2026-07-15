# Splunkbase listing — Carbide App for Splunk

Copy-paste content for the Splunkbase "App description" metadata form.
Repo-only (not shipped in the package). Keep in sync with README.md when
features change.

---

## Summary (required, 80–3000 chars)

Carbide answers one question continuously: **is every data source that should be reporting into Splunk actually reporting — on time and in full?**

Silent feed failures are usually discovered too late: a forwarder dies, an API token expires, a log rotation breaks — and nobody notices until an investigation comes up empty. Carbide watches for exactly that. It discovers what reports into your indexes (per host, source, or sourcetype), lets you choose what matters, and then tracks three things per entity: **gap** (how long since the last event was generated), **ingest latency** (delay between event time and index time), and optionally **volume** (24h event count vs a learned baseline — catching feeds that keep trickling on time while most of the volume is lost).

Everything is tstats-powered — discovery and status calculation never scan raw events, and indexer cost scales with your watch list, not the size of your estate. Configuration is inline and bulk-editable: per-entity thresholds with human-friendly durations (7h, 1d, 1w), monitoring schedules (24/7, weekdays, business hours with holiday calendar and Monday-morning grace), maintenance windows, tags, and auto-watch rules that onboard newly discovered entities automatically. Alerts fire once on the transition into a bad state — not repeatedly while it persists.

Redundant pools get **HA cluster monitoring**: group members by tag, set a quorum (e.g. at least 60% must report), and one dead node in a load-balanced farm stays quiet while the redundancy absorbs it — losing quorum is what alerts, with the full list of failing members. Member alerts, the Home dashboard and the pager all tell the same story.

For Splunk Enterprise Security users, Carbide ships notable events, risk-based alerting, CIM Alerts data model alignment, asset enrichment, and Incident Review drilldowns to a per-entity detail page — all silently inactive on installs without ES.

No license key, no external dependencies, no data model accelerations, no scripted inputs. One dedicated index (you create it), seven KV store collections, and a set of scheduled searches you can read and edit.

## Short description (≤380 chars)

Know when a host, source or sourcetype stops reporting — before someone asks where the data went. Per-entity gap, latency and volume-drop detection with learned baselines, HA cluster quorum tracking, business-hours schedules, auto-onboarding rules and transition-based alerts. tstats-powered (no raw scans), KV-backed, inline-editable. ES integration included, works without ES.

## Details

### How it works

1. **Discovery** (every 4 hours, tstats-only) inventories what reports into your indexes. Two modes are on by default — hosts by index+host, sourcetypes by index+sourcetype — and three advanced modes (host+sourcetype, host+source, index+source) can be enabled per axis. Include/exclude filter rules (Splunk wildcards, per-mode scoping) keep noise out.
2. **You pick what to watch** on the Manage entities page — filter, then one click on the quick-action row (or a bulk CSV import). Optionally define **auto-watch rules**: newly discovered entities matching a rule are onboarded automatically with watching enabled, thresholds, schedule and tags applied.
3. **Status snapshots** (every 5 minutes) compute each watched entity's state: OK, LATE (ingest latency above threshold), DOWN (quiet longer than allowed), CRITICAL (both), LOW_VOLUME (24h count below N% of learned baseline), plus SETTLING (grace after a schedule reopens), MAINT (snoozed), OFF_HOURS (outside its monitoring schedule) and NEW.
4. **Alerts** (Hosts, Sources, Clusters) fire on the *transition* into a bad state — an ongoing outage does not re-alert every cycle. Entities grouped into an HA cluster can suppress their individual alerts while the cluster still meets quorum; the cluster alert takes over the moment it doesn't. Wire email/webhook/PagerDuty actions on the saved searches.

### Day-2 features

- **HA clusters (quorum monitoring)**: group redundant entities by tag and define what "healthy" means — at least N% of members reporting, optionally with an absolute floor for small pools. One dead node in a 20-node syslog farm stays quiet; losing quorum alerts with the full failing-member list. Snoozed and off-hours members are excluded from the math on both sides, cluster membership is flagged on every entity view, and Home hides absorbed member outages so the dashboard matches what actually pages.
- **Per-entity thresholds** edited inline with human-friendly durations (15m, 7h, 1d, 1w); a threshold-suggestions dashboard proposes values from 7-day P95 latency and average event interval. Bulk quick actions set thresholds and tags across a filtered or ticked selection in one prompt. Guard rails included: the UI refuses a latency tolerance the status search couldn't actually observe (see `carbide_status_window`).
- **Monitoring schedules**: 24/7, weekdays, or business hours per entity, with a global holiday calendar and a configurable grace window after the schedule reopens so Monday mornings don't page you for the weekend's silence.
- **Maintenance windows**: snooze now or schedule a future window, per row or in bulk.
- **Availability view**: per-entity daily heatmap plus dwell-based availability % and downtime totals over 7/30/90 days.
- **Trends** from a dedicated index of status *transitions* (change-only writes plus an hourly heartbeat for non-OK entities — steady state indexes nothing).
- **Daily digest email**: one morning mail listing everything currently missing, delayed or below volume.
- **Review queue with dismiss**, stale-entity cleanup, CSV export/import everywhere, tags with contains-filtering, and an audit trail of every KV write sourced from Splunk's own access logs.

### Splunk Enterprise Security (optional, auto-detected)

Notable events with Incident Review drilldown to the entity page, risk-based alerting on the affected host, CIM Alerts data model alignment (tag=alert), and per-host asset enrichment (criticality/owner/BU) — populated manually or synced from the ES asset framework. Every ES action is a silent no-op on installs without ES.

### Requirements

- Splunk Enterprise or Splunk Cloud, standalone or distributed; search head clustering supported (all collections replicate, nothing writes to local/).
- One index named `carbide` that **you create** (any name works via the `carbide_index` macro) — the app deliberately ships no indexes.conf.
- KV store enabled on the search head.
- No forwarder-side or indexer-side components; install on search heads.

## Installation

1. **Create the index.** Carbide stores status-transition history in a dedicated index and does not ship an indexes.conf (index definitions belong to your indexing tier and retention policy). Create an index named `carbide` on your indexers (or a standalone search head):

   ```
   [carbide]
   homePath   = $SPLUNK_DB/carbide/db
   coldPath   = $SPLUNK_DB/carbide/colddb
   thawedPath = $SPLUNK_DB/carbide/thaweddb
   frozenTimePeriodInSecs = 7776000
   ```

   To use a different name, point the `carbide_index` search macro at it after installing. On Splunk Cloud, create the index through the Cloud admin UI.

2. **Install the app** on your search head(s): Apps > Manage Apps > Install app from file, or extract to `$SPLUNK_HOME/etc/apps/`. For search head clusters, deploy through the SHC deployer. Restart Splunk (KV store collections register on first load).

3. **Run the seed searches — BEFORE discovery.** From Settings > Searches, reports, and alerts, run "Carbide - Seed Entity Filters" and "Carbide - Seed Holidays" once. The first installs the default exclude rules (internal `_*` indexes, `summary`, `history`); the second pre-fills the holiday calendar. Both are idempotent — they only populate an empty collection and never overwrite your edits — and they also run hourly on their own, but if discovery runs before the filter seed it will inventory all the internal-index noise the rules exist to exclude (harmless, but you'll be deleting rows). Seed first, discover second.

4. **Run discovery.** The Home page walks you through the bootstrap: optionally add your own entity filters and auto-watch rules first (both pages have a dry-run discovery preview), then run the two default discovery searches once from Settings > Searches (they also run every 4 hours on their own).

5. **Pick what to watch** on Manage entities — filter and use the quick-action row, or let your auto-watch rules onboard entities automatically. Redundant pools can be grouped into HA clusters (Manage > Clusters): tag the members with the cluster's name and set the quorum.

6. **Arm the alerts.** The alert searches (Hosts, Sources, Clusters) are enabled with 30-minute per-entity suppression but send nothing until you add actions: fill in `action.email.to` or attach webhook/PagerDuty actions under Settings > Searches, reports, and alerts. The optional daily-digest search works the same way.

Verify the install on Settings > App health: every collection, macro, the index and the saved searches are self-tested there in one glance.

## Troubleshooting

**Home shows zeros / Trends and Availability are empty.**
The `carbide` index probably doesn't exist or isn't reachable from the search head. Create it on the indexer tier (see Installation) and check Settings > App health — the self-test panel flags a missing index explicitly. History only accumulates from the moment the index exists.

**Discovery finds nothing.**
Check your entity-filter rules on Manage > Entity Filters — the shipped seed rules exclude internal indexes (`_*`), `summary` and `history`; an over-broad exclude can empty the result. Use the "Preview discovery (dry run)" panel on that page: it runs the discovery search read-only and shows exactly what the current rules would let through. Discovery also ignores entities below the minimum event count (`carbide_min_event_count` macro).

**Everything shows "Just discovered" / nothing has a live status.**
Only *watched* entities get status. Flip "Start watching" on Manage entities, then wait one snapshot cycle (5 minutes).

**Discovery inventoried internal indexes (`_internal`, `_audit`, `summary`…).**
Discovery ran before the seed search installed the default exclude rules. Run "Carbide - Seed Entity Filters" (idempotent — it only fills an empty collection), then delete the noise rows in Manage entities; with the rules in place they won't be re-discovered.

**An entity is marked DOWN but data arrives — or its "Alert if quiet for" is several days.**
Statuses come from the snapshot searches every 5 minutes; give a new threshold one cycle to take effect. Entities that legitimately report less often than daily are supported (the last-seen time persists across search windows), just set `max_gap` accordingly — the threshold-suggestions page proposes sane values from observed intervals. One more cause worth checking: if the feed's *ingest lag* exceeds the status search window (`carbide_status_window`, default 24h on event time), events arrive already too old for the snapshot to see and the last-seen time freezes. Compare `max(_time)` against `latest(_indextime)` for the entity; if the lag is real, widen the macro (e.g. `-72h@h`) — the UI's latency limit follows it automatically.

**A DOWN host doesn't appear on Home and didn't alert.**
Check its tags: a 🛡 tag means it's a member of an HA cluster with member-alert suppression. While the cluster still meets quorum, individual member outages are deliberately absorbed — that's the feature, not a miss. The member is still listed in Manage entities (status DOWN) and in the cluster's "Not reporting" column on Manage > Clusters; losing quorum fires the cluster alert with the full failing list.

**The UI refuses a large "Alert if delayed by" value.**
The status check only looks back `carbide_status_window` (default 24h) on event time, so tolerating more latency than the window would make acceptably-late events invisible and false-flag the entity as missing. Widen the macro first (Settings > Advanced search > Search macros), then set the threshold — the UI limit follows the macro.

**A weekday/business-hours entity goes DOWN every Monday morning.**
That's what the reopen grace is for: after the schedule reopens the entity holds in SETTLING for `carbide_default_offhours_grace` (default 1h, per-entity overridable) before DOWN can fire. Raise the grace if your first events arrive later.

**Alerts fire but emails don't arrive.**
The alert actions ship unconfigured by design. Set `action.email.to` on "Carbide - Alert: Hosts" / "Carbide - Alert: Sources" / "Carbide - Alert: Clusters", and confirm your Splunk mail server settings (Settings > Server settings > Email settings). The cluster alert is email-only on purpose — quorum loss is an availability signal; the ES notable/risk actions ride on the host alerts.

**Edits on the Manage pages don't save / tables are read-only.**
Write access to the KV collections requires the admin, power or sc_admin role. Read-only users see the data but can't edit.

**Pages look stale after an upgrade.**
Splunk caches static assets. Bump the static-asset cache (`.../_bump` endpoint) or hard-refresh the browser; each Carbide page footer shows its `ui` and `css` versions so you can confirm the new assets loaded.

**The Settings > Audit trail is empty.**
It reads Splunk's own access logs from `index=_internal`, so the viewing user needs search access to `_internal`. Writes appear within seconds of an edit.

**ES actions warn on a non-ES install.**
The notable/risk actions log a skip warning without Enterprise Security and do nothing else — email and other actions on the same alert are unaffected. This is expected.
