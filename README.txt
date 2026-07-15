Carbide App for Splunk
======================

Lightweight data-source gap, latency & volume monitor. See README.md for
full documentation.

Quick start:

  1. Create an index named "carbide" (the app does NOT ship an
     indexes.conf) on the indexer tier, or locally on a standalone
     search head. To use a different name, point the carbide_index
     macro at it.
  2. Drop this directory into $SPLUNK_HOME/etc/apps/ and restart Splunk.
  3. Open the "Carbide App for Splunk" app on a search head.
  4. Run the seed searches BEFORE discovery (Settings > Searches,
     reports, and alerts): "Carbide - Seed Entity Filters" installs the
     default exclude rules (internal indexes etc.), "Carbide - Seed
     Holidays" pre-fills the holiday calendar. Both are idempotent and
     also run hourly on their own.
  5. Let discovery run (every 4 hours) or run it on demand:
     "Carbide - Discover hosts (recommended)" and
     "Carbide - Discover sourcetypes (recommended)".
  6. Open "Manage entities" and click "Start watching" on the entities
     you want Carbide to watch (or set up "Manage > Auto-watch rules"
     to onboard matching entities automatically at discovery).

The three alerts (Hosts, Sources, Clusters) ship enabled with 30-minute
per-entity suppression. The notable and risk actions no-op without
Enterprise Security; the email actions are pre-templated but send
nothing until you fill in action.email.to in Settings > Searches,
reports, and alerts. Redundant pools can be grouped into HA clusters
(Manage > Clusters): tag the members, set a quorum, and single-node
outages stay quiet while the cluster absorbs them.
