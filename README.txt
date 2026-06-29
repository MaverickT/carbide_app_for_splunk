Carbide for Splunk
==================

Lightweight data-source gap & latency monitor. See README.md for full
documentation.

Quick start:

  1. Drop this directory into $SPLUNK_HOME/etc/apps/ and restart Splunk.
  2. Open the "Carbide for Splunk" app on a search head.
  3. Let discovery run (hourly schedules) or run it on demand from
     Settings > Searches, reports, and alerts.
  4. Open "Manage > Hosts" / "Manage > Sources" and flip monitored=1
     on the entities you want Carbide to watch.

Alerts ship enabled with 30-minute suppression but no actions wired.
Attach email / webhook / PagerDuty actions per your environment in
Settings > Searches, reports, and alerts.
