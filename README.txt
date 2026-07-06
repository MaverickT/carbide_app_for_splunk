Carbide for Splunk
==================

Lightweight data-source gap, latency & volume monitor. See README.md for
full documentation.

Quick start:

  1. Create an index named "carbide" (the app does NOT ship an
     indexes.conf) on the indexer tier, or locally on a standalone
     search head. To use a different name, point the carbide_index
     macro at it.
  2. Drop this directory into $SPLUNK_HOME/etc/apps/ and restart Splunk.
  3. Open the "Carbide for Splunk" app on a search head.
  4. Let discovery run (every 4 hours) or run it on demand from
     Settings > Searches, reports, and alerts:
     "Carbide - Discover hosts (recommended)" and
     "Carbide - Discover sourcetypes (recommended)".
  5. Open "Manage entities" and click "Start watching" on the entities
     you want Carbide to watch (or set up "Manage > Auto-watch rules"
     to onboard matching entities automatically at discovery).

The two alerts (Hosts, Sources) ship enabled with 30-minute per-entity
suppression. Their notable and risk actions no-op without Enterprise
Security; the email action is pre-templated but sends nothing until you
fill in action.email.to in Settings > Searches, reports, and alerts.
