/**
 * Carbide for Splunk - custom HTML views engine
 * ----------------------------------------------
 * One script serves every Manage page. Each view's template
 * (appserver/templates/<view>.html) renders
 *     <div id="carbide-manage" class="carbide-page" data-page="<view>">
 * and this script routes on data-page:
 *
 *   manage_entities        tracked hosts/sources: filters, checkbox
 *                          selection, quick actions, inline edit, delete
 *   manage_assets          per-host asset metadata CRUD
 *   manage_holidays        holiday calendar CRUD
 *   manage_entity_filters  include/exclude rule CRUD
 *   manage_suggestions     threshold proposals (oneshot search) + apply
 *
 * No SplunkJS / requirejs. Plain fetch() against splunkd:
 *   - KV store REST for all reads/writes (POST replaces the whole doc,
 *     so we always write back the full row we loaded).
 *   - One oneshot search job for the suggestion macros.
 */
(function () {
    'use strict';

    var APP = 'carbide_app_for_splunk';
    var BASE = location.pathname.split('/app/')[0]; // e.g. "/en-US"
    var CHUNK = 200;

    // Bump on every change. Rendered in the filter bar + logged to the
    // console so "is the server/browser serving a stale copy?" is a
    // one-glance check instead of a debugging session.
    var VERSION = '2026-07-02.10';
    try { console.log('[carbide] manage ui version ' + VERSION); } catch (e) { /* ignore */ }

    // ------------------------------------------------------------- REST

    function csrfToken() {
        var m = document.cookie.match(/splunkweb_csrf_token_[^=]*=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function kvUrl(collection, key) {
        return BASE + '/splunkd/__raw/servicesNS/nobody/' + APP +
               '/storage/collections/data/' + collection +
               (key ? '/' + encodeURIComponent(key) : '');
    }

    function rest(method, url, body, headers) {
        return fetch(url, {
            method: method,
            credentials: 'same-origin',
            headers: Object.assign({
                'X-Requested-With': 'XMLHttpRequest',
                'X-Splunk-Form-Key': csrfToken()
            }, headers || { 'Content-Type': 'application/json' }),
            body: body
        }).then(function (resp) {
            if (!resp.ok) {
                return resp.text().then(function (txt) {
                    throw new Error(method + ' ' + resp.status + ': ' + txt.slice(0, 300));
                });
            }
            return resp.status === 204 ? null : resp.json().catch(function () { return null; });
        });
    }

    function kvList(coll)        { return rest('GET', kvUrl(coll)); }
    function kvSave(coll, doc)   { return rest('POST', kvUrl(coll, doc._key), JSON.stringify(stripKey(doc))); }
    function kvCreate(coll, doc) { return rest('POST', kvUrl(coll), JSON.stringify(doc)); }
    function kvDelete(coll, key) { return rest('DELETE', kvUrl(coll, key)); }
    function kvBatchSave(coll, docs) {
        return rest('POST', kvUrl(coll) + '/batch_save', JSON.stringify(docs));
    }

    // Synchronous (oneshot) search in the app namespace so macros resolve.
    function oneshot(spl, earliest, latest) {
        var params = new URLSearchParams({
            search: spl,
            exec_mode: 'oneshot',
            output_mode: 'json',
            count: '0',
            earliest_time: earliest || '-7d@h',
            latest_time: latest || 'now'
        });
        return rest('POST',
            BASE + '/splunkd/__raw/servicesNS/nobody/' + APP + '/search/jobs',
            params.toString(),
            { 'Content-Type': 'application/x-www-form-urlencoded' }
        ).then(function (data) { return (data && data.results) || []; });
    }

    function stripKey(doc) {
        var out = {};
        Object.keys(doc).forEach(function (k) {
            if (k !== '_key' && k !== '_user') out[k] = doc[k];
        });
        return out;
    }

    function chunked(docs) {
        var out = [];
        for (var i = 0; i < docs.length; i += CHUNK) out.push(docs.slice(i, i + CHUNK));
        return out;
    }

    function batchSaveAll(coll, docs) {
        return chunked(docs).reduce(function (p, c) {
            return p.then(function () { return kvBatchSave(coll, c); });
        }, Promise.resolve());
    }

    // ------------------------------------------------------------- DOM helpers

    var root;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = String(text);
        return e;
    }

    function toast(msg, kind) {
        var t = el('div', 'carbide-toast ' + (kind === 'err' ? 'carbide-toast-err' : 'carbide-toast-ok'), msg);
        document.body.appendChild(t);
        setTimeout(function () { t.classList.add('gone'); setTimeout(function () { t.remove(); }, 400); }, 2600);
    }

    function now() { return Math.floor(Date.now() / 1000); }

    function fmtTs(v) {
        var n = Number(v);
        if (!n) return '-';
        var d = new Date(n * 1000);
        function p(x) { return (x < 10 ? '0' : '') + x; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
               p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function fmtDur(secs) {
        var n = Number(secs);
        if (!n || n <= 0) return '-';
        if (n < 60)    return n + ' s';
        if (n < 3600)  return Math.round(n / 6) / 10 + ' m';
        if (n < 86400) return Math.round(n / 360) / 10 + ' h';
        return Math.round(n / 8640) / 10 + ' d';
    }

    function fmtUntil(epoch) {
        var n = Number(epoch);
        if (!n) return '-';
        var d = n - now();
        if (d <= 0) return 'expired';
        return 'in ' + fmtDur(d);
    }

    function contains(hay, needle) {
        return String(hay == null ? '' : hay).toLowerCase().indexOf(needle) >= 0;
    }

    var DUR_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

    // "7h" / "90m" / "1.5d" / "1w" / "300" (bare number = seconds) -> seconds.
    // Returns null on anything it can't parse.
    function parseDuration(input) {
        var s = String(input == null ? '' : input).trim().toLowerCase();
        var m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/.exec(s);
        if (!m) return null;
        return Math.round(parseFloat(m[1]) * DUR_UNITS[m[2] || 's']);
    }

    // Seconds -> the shortest exact human form ("3600" -> "1h",
    // "5400" -> "90m", "90" -> "90s") for pre-filling duration editors.
    function humanShort(secs) {
        var n = Number(secs) || 0;
        if (n <= 0) return '0s';
        var units = [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
        for (var i = 0; i < units.length; i++) {
            if (n % units[i][1] === 0) return (n / units[i][1]) + units[i][0];
        }
        return n + 's';
    }

    function labeled(labelText, control) {
        var w = el('label', 'carbide-f');
        w.appendChild(el('span', 'carbide-f-label', labelText));
        w.appendChild(control);
        return w;
    }

    function select(options, value, onchange) {
        var s = el('select', 'carbide-input');
        options.forEach(function (o) {
            var opt = el('option', null, o.label !== undefined ? o.label : o);
            opt.value = o.value !== undefined ? o.value : o;
            s.appendChild(opt);
        });
        if (value !== undefined) s.value = value;
        if (onchange) s.addEventListener('change', function () { onchange(s.value); });
        return s;
    }

    function textInput(value, placeholder, oninput) {
        var i = el('input', 'carbide-input');
        i.type = 'text';
        i.value = value || '';
        i.placeholder = placeholder || '';
        if (oninput) {
            var t;
            i.addEventListener('input', function () {
                clearTimeout(t);
                t = setTimeout(function () { oninput(i.value); }, 250);
            });
        }
        return i;
    }

    function btn(label, cls, onclick) {
        var b = el('button', 'carbide-btn' + (cls ? ' ' + cls : ''), label);
        b.addEventListener('click', onclick);
        return b;
    }

    function versionTag() {
        var v = el('span', 'carbide-version', 'ui v' + VERSION);
        v.title = 'Version of carbide_manage.js the browser is running. If this lags the deployed file, run /_bump and hard-refresh.';
        return v;
    }

    // ------------------------------------------------------------- generic table

    // cols: [{key,label,render?,title?,edit?,sortVal?,noSort?}]
    // opts: {rows, sort:{key,dir}, onSort, onEdit(row,field,value), onDelete(row),
    //        selection?: {set:Set, allFiltered:[], onChange()},
    //        emptyText}
    function buildTable(cols, opts) {
        var wrap = el('div', 'carbide-tablewrap');
        var rows = opts.rows.slice();

        var sc = cols.filter(function (c) { return c.key === opts.sort.key; })[0];
        var sortVal = (sc && sc.sortVal) || function (r) { return r[opts.sort.key]; };
        rows.sort(function (a, b) {
            var x = sortVal(a), y = sortVal(b);
            if (typeof x === 'string' || typeof y === 'string') {
                x = String(x == null ? '' : x).toLowerCase();
                y = String(y == null ? '' : y).toLowerCase();
            } else { x = Number(x) || 0; y = Number(y) || 0; }
            return (x < y ? -1 : x > y ? 1 : 0) * opts.sort.dir;
        });

        var table = el('table', 'carbide-table');
        var htr = el('tr');

        if (opts.selection) {
            var thSel = el('th', 'carbide-selcol');
            var all = el('input');
            all.type = 'checkbox';
            all.title = 'Select / clear every row matching the current filter';
            var allSelected = opts.selection.allFiltered.length > 0 &&
                opts.selection.allFiltered.every(function (r) { return opts.selection.set.has(r._key); });
            all.checked = allSelected;
            all.addEventListener('change', function () {
                opts.selection.allFiltered.forEach(function (r) {
                    if (all.checked) opts.selection.set.add(r._key);
                    else opts.selection.set.delete(r._key);
                });
                opts.selection.onChange();
            });
            thSel.appendChild(all);
            htr.appendChild(thSel);
        }

        cols.forEach(function (c) {
            var th = el('th', null, c.label);
            if (!c.noSort) {
                th.classList.add('sortable');
                if (opts.sort.key === c.key) th.classList.add(opts.sort.dir === 1 ? 'asc' : 'desc');
                th.addEventListener('click', function () { opts.onSort(c.key); });
            }
            htr.appendChild(th);
        });
        if (opts.onDelete) htr.appendChild(el('th'));

        var thead = el('thead');
        thead.appendChild(htr);
        table.appendChild(thead);

        var tbody = el('tbody');
        if (!rows.length) {
            var tr0 = el('tr');
            var td0 = el('td', 'carbide-empty', opts.emptyText || 'Nothing here yet.');
            td0.colSpan = cols.length + (opts.selection ? 1 : 0) + (opts.onDelete ? 1 : 0);
            tr0.appendChild(td0);
            tbody.appendChild(tr0);
        }

        rows.forEach(function (r) {
            var tr = el('tr');

            if (opts.selection) {
                var tdSel = el('td', 'carbide-selcol');
                var cb = el('input');
                cb.type = 'checkbox';
                cb.checked = opts.selection.set.has(r._key);
                cb.addEventListener('change', function () {
                    if (cb.checked) opts.selection.set.add(r._key);
                    else opts.selection.set.delete(r._key);
                    opts.selection.onChange();
                });
                tdSel.appendChild(cb);
                tr.appendChild(tdSel);
            }

            cols.forEach(function (c) {
                var td = el('td');
                var content = c.render ? c.render(r) : (r[c.key] == null ? '' : String(r[c.key]));
                if (content instanceof Node) td.appendChild(content);
                else td.textContent = content;
                if (c.title) td.title = c.title(r);
                if (c.edit) {
                    td.classList.add('editable');
                    td.addEventListener('click', function () { beginEdit(td, r, c, opts.onEdit); });
                }
                tr.appendChild(td);
            });

            if (opts.onDelete) {
                var tdA = el('td');
                var trash = el('button', 'carbide-trash', '🗑');
                trash.title = 'Delete this row';
                trash.addEventListener('click', function () { opts.onDelete(r); });
                tdA.appendChild(trash);
                tr.appendChild(tdA);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    var SNOOZE_PRESETS = [
        { label: 'off',       secs: 0 },
        { label: '+15 min',   secs: 900 },
        { label: '+1 hour',   secs: 3600 },
        { label: '+4 hours',  secs: 14400 },
        { label: '+12 hours', secs: 43200 },
        { label: '+1 day',    secs: 86400 },
        { label: '+3 days',   secs: 259200 },
        { label: '+1 week',   secs: 604800 }
    ];

    function beginEdit(td, row, col, onEdit) {
        if (td.querySelector('input,select')) return;
        td.textContent = '';
        var input;
        var kind = col.edit.type;

        if (kind === 'select') {
            var opts = col.edit.options;
            var first = (opts[0] && opts[0].value !== undefined) ? opts[0].value : opts[0];
            input = select(opts, row[col.key] != null && row[col.key] !== '' ? row[col.key] : first);
            input.className = 'carbide-edit';
        } else if (kind === 'snooze') {
            input = select(SNOOZE_PRESETS.map(function (p) { return { value: String(p.secs), label: p.label }; }));
            input.className = 'carbide-edit';
        } else if (kind === 'duration') {
            input = el('input', 'carbide-edit');
            input.type = 'text';
            input.placeholder = 'e.g. 15m, 7h, 1d, 1w';
            input.value = humanShort(row[col.key]);
        } else {
            input = el('input', 'carbide-edit');
            input.type = kind === 'number' ? 'number' : 'text';
            if (col.edit.min !== undefined) input.min = col.edit.min;
            input.value = row[col.key] == null ? '' : row[col.key];
        }

        td.appendChild(input);
        input.focus();
        if (input.select) input.select();

        var done = false;
        function commit(cancel) {
            if (done) return;
            done = true;
            if (cancel) { onEdit(null); return; }
            var v;
            if (kind === 'snooze') {
                var secs = Number(input.value);
                v = secs === 0 ? 0 : now() + secs;
            } else if (kind === 'duration') {
                v = parseDuration(input.value);
                if (v === null || v < 0) {
                    toast(col.label + ': use a duration like 90s, 15m, 7h, 1d or 1w', 'err');
                    onEdit(null);
                    return;
                }
            } else if (kind === 'number') {
                v = Number(input.value);
                if (isNaN(v) || (col.edit.min !== undefined && v < col.edit.min)) {
                    toast(col.label + ' must be a number >= ' + (col.edit.min || 0), 'err');
                    onEdit(null);
                    return;
                }
            } else {
                v = String(input.value).trim();
            }
            if (col.edit.validate) {
                var err = col.edit.validate(v, row);
                if (err) { toast(err, 'err'); onEdit(null); return; }
            }
            if (v === row[col.key]) { onEdit(null); return; }
            onEdit({ row: row, field: col.key, value: v });
        }

        input.addEventListener('blur', function () { commit(false); });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter')  { ev.preventDefault(); input.blur(); }
            if (ev.key === 'Escape') { commit(true); }
        });
    }

    // =============================================================
    //  PAGE: manage_entities
    // =============================================================

    var STATUS_META = {
        UNWATCHED: { label: '– Not watched',       cls: 'off' },
        OK:        { label: '✓ Healthy',           cls: 'ok' },
        LATE:      { label: '⚠ Delayed',           cls: 'late' },
        DOWN:      { label: '✗ Missing data',      cls: 'down' },
        CRITICAL:  { label: '✗ Missing + delayed', cls: 'critical' },
        MAINT:     { label: '🔧 Snoozed',     cls: 'maint' },
        OFF_HOURS: { label: '🌙 Off-hours',   cls: 'offhours' },
        NEW:       { label: '· Just added',        cls: 'new' }
    };

    // Three UI axes over two KV collections: the sources collection is
    // split by tracking_mode into "Sources (file paths)" and "Sourcetypes".
    var ENT_AXES = {
        host:       { collection: 'carbide_tracked_hosts',   noun: 'host',
                      discoverHint: '"Carbide - Discover hosts (recommended)"' },
        source:     { collection: 'carbide_tracked_sources', noun: 'source',
                      modeFilter: function (r) { return r.tracking_mode !== 'index_sourcetype'; },
                      discoverHint: '"Carbide - Discover sources (advanced: index and source)" (ships disabled - enable it first)' },
        sourcetype: { collection: 'carbide_tracked_sources', noun: 'sourcetype',
                      modeFilter: function (r) { return r.tracking_mode === 'index_sourcetype'; },
                      discoverHint: '"Carbide - Discover sourcetypes (recommended)"' }
    };
    var HOST_TRACKING_MODES = ['index_host', 'host_source', 'host_sourcetype'];

    function entitiesPage() {
        var state = {
            axis: 'host',
            rows: { carbide_tracked_hosts: [], carbide_tracked_sources: [] },
            selected: { host: new Set(), source: new Set(), sourcetype: new Set() },
            loaded: false,
            watching: '*', status: '*', search: '', tag: '',
            details: false,
            sort: { key: 'entity_key', dir: 1 }
        };

        (function initFromQuery() {
            var q = new URLSearchParams(location.search);
            var t = q.get('form.type_tok');   if (ENT_AXES[t]) state.axis = t;
            var s = q.get('form.status_tok'); if (s) state.status = s;
            var f = q.get('form.search_tok'); if (f) state.search = f;
            var g = q.get('form.tag_tok');    if (g) state.tag = g;
        })();

        function axisRows() {
            var a = ENT_AXES[state.axis];
            var list = state.rows[a.collection];
            return a.modeFilter ? list.filter(a.modeFilter) : list;
        }

        // Status only exists for watched entities: the snapshot searches
        // evaluate monitored=1 rows only, so anything unwatched would sit
        // on its bootstrap "NEW" forever - show it as "Not watched" instead.
        function rowStatus(r) {
            if (Number(r.monitored) !== 1) return 'UNWATCHED';
            var from = Number(r.maintenance_from) || 0;
            var until = Number(r.maintenance_until) || 0;
            if (from <= now() && until > now()) return 'MAINT';
            return r.last_status || 'NEW';
        }

        function filtered() {
            var needle = state.search.trim().toLowerCase();
            var tag = state.tag.trim().toLowerCase();
            var statuses = state.status === '*' ? null : state.status.split('|');
            return axisRows().filter(function (r) {
                if (state.watching !== '*' && String(Number(r.monitored) || 0) !== state.watching) return false;
                if (statuses && statuses.indexOf(rowStatus(r)) < 0) return false;
                if (tag && !contains(r.tags, tag)) return false;
                if (needle) {
                    var hay = [r.entity_key, r.index, r.host, r.source, r.sourcetype, r.notes].join('|').toLowerCase();
                    if (hay.indexOf(needle) < 0) return false;
                }
                return true;
            });
        }

        function selectedRows(pool) {
            var set = state.selected[state.axis];
            return pool.filter(function (r) { return set.has(r._key); });
        }

        function saveField(change) {
            if (!change) { render(); return; }
            var row = change.row, prev = row[change.field];
            row[change.field] = change.value;
            row.last_updated = now();
            kvSave(ENT_AXES[state.axis].collection, row).then(function () {
                toast(change.field + ' saved');
                render();
            }).catch(function (e) {
                row[change.field] = prev;
                toast('save failed: ' + e.message, 'err');
                render();
            });
        }

        // Acts on CHECKED rows if any are checked; otherwise on every
        // filtered row. The confirm dialog always says which.
        function bulk(mutator, verb) {
            var pool = filtered();
            var sel = selectedRows(pool);
            var rows = sel.length ? sel : pool;
            var scope = sel.length ? rows.length + ' selected rows' : 'all ' + rows.length + ' filtered rows';
            if (!rows.length) { toast('no rows to act on', 'err'); return; }
            if (!confirm(verb + ' on ' + scope + '?')) return;
            var ts = now();
            rows.forEach(function (r) { mutator(r); r.last_updated = ts; });
            batchSaveAll(ENT_AXES[state.axis].collection, rows).then(function () {
                toast(verb + ': ' + rows.length + ' rows updated');
                render();
            }).catch(function (e) {
                toast('bulk update failed: ' + e.message, 'err');
                load();
            });
        }

        function columns() {
            var axis = state.axis;
            return [
                { key: 'status',              label: 'Status', sortVal: rowStatus,
                  render: function (r) {
                      var meta = STATUS_META[rowStatus(r)] || { label: rowStatus(r), cls: 'new' };
                      return el('span', 'carbide-chip carbide-chip-' + meta.cls, meta.label);
                  } },
                { key: 'monitored',           label: 'Watching', sortVal: function (r) { return Number(r.monitored) || 0; },
                  render: function (r) {
                      var on = Number(r.monitored) === 1;
                      var b = el('button', 'carbide-watch ' + (on ? 'on' : 'off'), on ? 'On' : 'Off');
                      b.title = on ? 'Watching - click to stop' : 'Not watching - click to start';
                      b.addEventListener('click', function () {
                          saveField({ row: r, field: 'monitored', value: on ? 0 : 1 });
                      });
                      return b;
                  } },
                { key: 'entity_key',          label: 'Entity' },
                { key: 'monitoring_schedule', label: 'Schedule', edit: { type: 'select', options: ['247', 'weekdays', 'business_hours'] },
                  render: function (r) { return r.monitoring_schedule || '247'; } },
                { key: 'tags',                label: 'Tags', edit: { type: 'text' } },
                { key: 'max_gap_seconds',     label: 'Alert if quiet for', edit: { type: 'duration' },
                  render: function (r) { return fmtDur(r.max_gap_seconds); },
                  title: function (r) { return (r.max_gap_seconds || 0) + ' s - click to edit (15m, 7h, 1d, 1w...)'; } },
                { key: 'max_latency_seconds', label: 'Alert if delayed by', edit: { type: 'duration' },
                  render: function (r) { return fmtDur(r.max_latency_seconds); },
                  title: function (r) { return (r.max_latency_seconds || 0) + ' s - click to edit (15m, 7h, 1d, 1w...)'; } },
                { key: 'maintenance_until',   label: 'Snoozed until', edit: { type: 'snooze' },
                  render: function (r) { return fmtUntil(r.maintenance_until); },
                  title: function (r) { return fmtTs(r.maintenance_until); } },
                { key: 'last_event_time',     label: 'Last event', render: function (r) { return fmtTs(r.last_event_time); } },
                { key: 'maintenance_from',    label: 'Snooze from', detail: true, edit: { type: 'snooze' },
                  render: function (r) { return Number(r.maintenance_from) ? fmtTs(r.maintenance_from) : '-'; } },
                { key: 'tracking_mode',       label: 'Grouped by', detail: true,
                  edit: axis === 'host' ? { type: 'select', options: HOST_TRACKING_MODES } : undefined },
                { key: 'first_seen',          label: 'First seen', detail: true, render: function (r) { return fmtTs(r.first_seen); } },
                { key: 'last_updated',        label: 'Last updated', detail: true, render: function (r) { return fmtTs(r.last_updated); } },
                { key: 'notes',               label: 'Notes', detail: true, edit: { type: 'text' } }
            ].filter(function (c) { return !c.detail || state.details; });
        }

        function render() {
            root.textContent = '';

            var bar = el('div', 'carbide-filters');
            bar.appendChild(labeled('I want to manage', select(
                [{ value: 'host', label: 'Hosts' },
                 { value: 'sourcetype', label: 'Sourcetypes' },
                 { value: 'source', label: 'Sources (file paths)' }],
                state.axis, function (v) { state.axis = v; render(); })));
            bar.appendChild(labeled('Watching', select(
                [{ value: '*', label: 'All' }, { value: '1', label: 'On (watching)' }, { value: '0', label: 'Off (not watching)' }],
                state.watching, function (v) { state.watching = v; render(); })));
            bar.appendChild(labeled('Status', select(
                [{ value: '*', label: 'All' },
                 { value: 'OK', label: 'Healthy' },
                 { value: 'LATE', label: 'Delayed' },
                 { value: 'DOWN|CRITICAL', label: 'Missing (DOWN / CRITICAL)' },
                 { value: 'MAINT', label: 'Snoozed' },
                 { value: 'OFF_HOURS', label: 'Off-hours' },
                 { value: 'NEW', label: 'Just added (watched, no snapshot yet)' },
                 { value: 'UNWATCHED', label: 'Not watched' }],
                state.status, function (v) { state.status = v; render(); })));
            bar.appendChild(labeled('Search (contains)', textInput(state.search, 'entity, index, host, notes...', function (v) { state.search = v; render(); })));
            bar.appendChild(labeled('Tag (contains)', textInput(state.tag, 'prod, payments...', function (v) { state.tag = v; render(); })));
            bar.appendChild(labeled('Show details', select(
                [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }],
                state.details ? '1' : '0', function (v) { state.details = v === '1'; render(); })));
            bar.appendChild(btn('↻ Refresh', null, load));
            bar.appendChild(versionTag());
            root.appendChild(bar);

            var pool = filtered();
            var selCount = selectedRows(pool).length;

            var actions = el('div', 'carbide-actions');
            actions.appendChild(el('span', 'carbide-actions-title',
                selCount ? 'Quick actions on ' + selCount + ' selected rows'
                         : 'Quick actions on all ' + pool.length + ' filtered rows (tick rows to narrow)'));
            actions.appendChild(btn('Start watching', null, function () { bulk(function (r) { r.monitored = 1; }, 'Start watching'); }));
            actions.appendChild(btn('Stop watching', 'danger', function () { bulk(function (r) { r.monitored = 0; }, 'Stop watching'); }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('🔧 Snooze 1h', null, function () { bulk(function (r) { r.maintenance_until = now() + 3600; }, 'Snooze 1h'); }));
            actions.appendChild(btn('🔧 Snooze 1d', null, function () { bulk(function (r) { r.maintenance_until = now() + 86400; }, 'Snooze 1d'); }));
            actions.appendChild(btn('End snooze', null, function () { bulk(function (r) { r.maintenance_until = 0; }, 'End snooze'); }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('📅 24/7', null, function () { bulk(function (r) { r.monitoring_schedule = '247'; }, 'Set schedule 24/7'); }));
            actions.appendChild(btn('📅 Weekdays', null, function () { bulk(function (r) { r.monitoring_schedule = 'weekdays'; }, 'Set schedule weekdays'); }));
            actions.appendChild(btn('📅 Business hrs', null, function () { bulk(function (r) { r.monitoring_schedule = 'business_hours'; }, 'Set schedule business hours'); }));
            if (selCount) {
                actions.appendChild(el('span', 'carbide-sep'));
                actions.appendChild(btn('Clear selection', null, function () {
                    state.selected[state.axis].clear();
                    render();
                }));
            }
            root.appendChild(actions);

            root.appendChild(el('div', 'carbide-count',
                pool.length + ' of ' + axisRows().length + ' tracked ' +
                ENT_AXES[state.axis].noun + ' entities' +
                (selCount ? ' - ' + selCount + ' selected' : '') +
                (state.loaded ? '' : ' (loading…)')));

            root.appendChild(buildTable(columns(), {
                rows: pool,
                sort: state.sort,
                onSort: function (key) {
                    if (state.sort.key === key) state.sort.dir = -state.sort.dir;
                    else state.sort = { key: key, dir: 1 };
                    render();
                },
                onEdit: saveField,
                selection: {
                    set: state.selected[state.axis],
                    allFiltered: pool,
                    onChange: render
                },
                onDelete: function (r) {
                    if (!confirm('Stop tracking ' + r.entity_key + ' ? (KV row is deleted; data ingestion unaffected)')) return;
                    kvDelete(ENT_AXES[state.axis].collection, r._key).then(function () {
                        var list = state.rows[ENT_AXES[state.axis].collection];
                        var i = list.indexOf(r);
                        if (i >= 0) list.splice(i, 1);
                        state.selected[state.axis].delete(r._key);
                        toast('removed ' + r.entity_key);
                        render();
                    }).catch(function (e) { toast('delete failed: ' + e.message, 'err'); });
                },
                emptyText: axisRows().length
                    ? 'No entities match the current filter.'
                    : 'Nothing tracked on this axis yet - run ' + ENT_AXES[state.axis].discoverHint + ' from Settings › Searches, then refresh.'
            }));
        }

        function load() {
            state.loaded = false;
            Promise.all([kvList('carbide_tracked_hosts'), kvList('carbide_tracked_sources')]).then(function (res) {
                state.rows.carbide_tracked_hosts = res[0] || [];
                state.rows.carbide_tracked_sources = res[1] || [];
                state.loaded = true;
                render();
            }).catch(function (e) {
                root.textContent = '';
                root.appendChild(el('div', 'carbide-error', 'Could not load the tracked-entity collections: ' + e.message));
            });
        }

        render();
        load();
    }

    // =============================================================
    //  Generic KV CRUD page (assets / holidays / entity filters)
    // =============================================================

    function crudPage(cfg) {
        var state = { rows: [], loaded: false, search: '', sort: { key: cfg.sortKey, dir: 1 }, add: {} };

        function filtered() {
            var needle = state.search.trim().toLowerCase();
            if (!needle) return state.rows.slice();
            return state.rows.filter(function (r) {
                return cfg.searchFields.some(function (f) { return contains(r[f], needle); });
            });
        }

        function saveField(change) {
            if (!change) { render(); return; }
            var row = change.row, prev = row[change.field];
            row[change.field] = change.value;
            row.last_updated = now();
            kvSave(cfg.collection, row).then(function () {
                toast(change.field + ' saved');
                render();
            }).catch(function (e) {
                row[change.field] = prev;
                toast('save failed: ' + e.message, 'err');
                render();
            });
        }

        function render() {
            root.textContent = '';

            if (cfg.intro) {
                var intro = el('div', 'carbide-intro');
                intro.textContent = cfg.intro;
                root.appendChild(intro);
            }

            var bar = el('div', 'carbide-filters');
            bar.appendChild(labeled('Search (contains)', textInput(state.search, '', function (v) { state.search = v; render(); })));
            bar.appendChild(btn('↻ Refresh', null, load));
            bar.appendChild(versionTag());
            root.appendChild(bar);

            // Add form. Values live in state.add so they survive re-renders:
            // dropdown choices STICK between adds (entering five similar
            // rules doesn't mean re-picking everything five times); only
            // the fields in cfg.clearAfterAdd reset after a successful add.
            // Enter in any text field submits.
            function addValue(f) {
                if (state.add[f.key] !== undefined) return state.add[f.key];
                if (f.value !== undefined) return f.value;
                if (f.options) {
                    var o = f.options[0];
                    return (o && o.value !== undefined) ? o.value : o;
                }
                return '';
            }
            function doAdd() {
                var doc = Object.assign({}, cfg.addDefaults || {});
                cfg.addForm.forEach(function (f) {
                    var v = addValue(f);
                    doc[f.key] = f.numeric ? Number(v) : String(v).trim();
                });
                var err = cfg.validate && cfg.validate(doc);
                if (err) { toast(err, 'err'); return; }
                kvCreate(cfg.collection, doc).then(function (resp) {
                    doc._key = resp && resp._key;
                    state.rows.push(doc);
                    (cfg.clearAfterAdd || []).forEach(function (k) { delete state.add[k]; });
                    toast('added');
                    render();
                }).catch(function (e) { toast('add failed: ' + e.message, 'err'); });
            }
            var form = el('div', 'carbide-actions carbide-addform');
            form.appendChild(el('span', 'carbide-actions-title', cfg.addTitle));
            cfg.addForm.forEach(function (f) {
                var control;
                if (f.options) {
                    control = select(f.options, addValue(f), function (v) { state.add[f.key] = v; });
                } else {
                    control = textInput(addValue(f), f.placeholder, null);
                    control.addEventListener('input', function () { state.add[f.key] = control.value; });
                    control.addEventListener('keydown', function (ev) {
                        if (ev.key === 'Enter') { ev.preventDefault(); doAdd(); }
                    });
                }
                form.appendChild(labeled(f.label, control));
            });
            form.appendChild(btn('Add', null, doAdd));
            root.appendChild(form);

            var pool = filtered();
            root.appendChild(el('div', 'carbide-count',
                pool.length + ' of ' + state.rows.length + ' rows' + (state.loaded ? '' : ' (loading…)')));

            root.appendChild(buildTable(cfg.columns, {
                rows: pool,
                sort: state.sort,
                onSort: function (key) {
                    if (state.sort.key === key) state.sort.dir = -state.sort.dir;
                    else state.sort = { key: key, dir: 1 };
                    render();
                },
                onEdit: saveField,
                onDelete: function (r) {
                    if (!confirm('Delete this row (' + (r[cfg.sortKey] || r._key) + ') ?')) return;
                    kvDelete(cfg.collection, r._key).then(function () {
                        var i = state.rows.indexOf(r);
                        if (i >= 0) state.rows.splice(i, 1);
                        toast('deleted');
                        render();
                    }).catch(function (e) { toast('delete failed: ' + e.message, 'err'); });
                },
                emptyText: cfg.emptyText
            }));
        }

        function load() {
            state.loaded = false;
            kvList(cfg.collection).then(function (rows) {
                state.rows = rows || [];
                state.loaded = true;
                render();
            }).catch(function (e) {
                root.textContent = '';
                root.appendChild(el('div', 'carbide-error', 'Could not load ' + cfg.collection + ': ' + e.message));
            });
        }

        render();
        load();
    }

    var FILTER_SCOPES = [
        { value: 'both',             label: 'everything (hosts + sources)' },
        { value: 'hosts',            label: 'hosts axis (every host mode)' },
        { value: 'sources',          label: 'sources axis (every source mode)' },
        { value: 'index_host',       label: 'only: hosts by index+host' },
        { value: 'host_source',      label: 'only: hosts by host+source' },
        { value: 'host_sourcetype',  label: 'only: hosts by host+sourcetype' },
        { value: 'index_sourcetype', label: 'only: sourcetypes by index+sourcetype' },
        { value: 'index_source',     label: 'only: sources by index+source' }
    ];
    var FILTER_SCOPE_LABELS = {};
    FILTER_SCOPES.forEach(function (s) { FILTER_SCOPE_LABELS[s.value] = s.label; });

    var CRUD_PAGES = {
        manage_assets: {
            collection: 'carbide_assets',
            intro: 'Per-host metadata joined into host status: alerts and dashboards carry criticality / owner / business unit. Works without ES - add rows here, or enable the "Carbide - Sync ES asset_lookup_by_str" saved search. An empty table is a valid state.',
            sortKey: 'host',
            searchFields: ['host', 'owner', 'business_unit', 'notes'],
            columns: [
                { key: 'host',          label: 'Host', edit: { type: 'text' } },
                { key: 'criticality',   label: 'Criticality', edit: { type: 'select', options: ['low', 'medium', 'high', 'critical'] },
                  render: function (r) {
                      return el('span', 'carbide-chip carbide-crit-' + (r.criticality || 'medium'), r.criticality || 'medium');
                  } },
                { key: 'owner',         label: 'Owner', edit: { type: 'text' } },
                { key: 'business_unit', label: 'Business unit', edit: { type: 'text' } },
                { key: 'source',        label: 'Source' },
                { key: 'notes',         label: 'Notes', edit: { type: 'text' } }
            ],
            addTitle: 'Add asset',
            addForm: [
                { key: 'host', label: 'Host', placeholder: 'e.g. web01.prod' },
                { key: 'criticality', label: 'Criticality', options: ['low', 'medium', 'high', 'critical'], value: 'medium' },
                { key: 'owner', label: 'Owner', placeholder: 'owner@example.com' },
                { key: 'business_unit', label: 'Business unit', placeholder: 'payments' },
                { key: 'notes', label: 'Notes', placeholder: 'optional' }
            ],
            addDefaults: { source: 'manual' },
            clearAfterAdd: ['host', 'owner', 'business_unit', 'notes'],
            validate: function (d) { if (!d.host) return 'host is required'; },
            emptyText: 'No asset rows yet - add hosts that matter, or sync from ES.'
        },

        manage_holidays: {
            collection: 'carbide_holidays',
            intro: 'Global holiday calendar for the weekdays / business_hours schedules: on a holiday those entities report Off-hours and alerts skip them. Fixed dates use YYYY-MM-DD (one year only); recurring holidays use MM-DD and apply every year.',
            sortKey: 'date',
            searchFields: ['date', 'name', 'notes'],
            columns: [
                { key: 'date',      label: 'Date', edit: { type: 'text', validate: validateHolidayDate } },
                { key: 'name',      label: 'Name', edit: { type: 'text' } },
                { key: 'recurring', label: 'Repeats yearly', edit: { type: 'select', options: ['1', '0'] },
                  render: function (r) { return Number(r.recurring) === 1 ? 'yes (MM-DD)' : 'no (fixed date)'; } },
                { key: 'notes',     label: 'Notes', edit: { type: 'text' } }
            ],
            addTitle: 'Add holiday',
            addForm: [
                { key: 'date', label: 'Date', placeholder: '2026-12-25 or 12-25' },
                { key: 'name', label: 'Name', placeholder: 'Christmas' },
                { key: 'recurring', label: 'Repeats yearly', numeric: true,
                  options: [{ value: '0', label: 'No (fixed YYYY-MM-DD)' }, { value: '1', label: 'Yes (annual MM-DD)' }] },
                { key: 'notes', label: 'Notes', placeholder: 'optional' }
            ],
            clearAfterAdd: ['date', 'name', 'notes'],
            validate: function (d) {
                if (!d.date) return 'date is required';
                return validateHolidayDate(d.date, d);
            },
            emptyText: 'No holidays defined - schedules only respect weekends and clock hours.'
        },

        manage_entity_filters: {
            collection: 'carbide_entity_filters',
            intro: 'Include/exclude rules on any of index / host / source / sourcetype. Patterns support Splunk wildcards (* and ?). ' +
                   'Scope a rule to a whole axis (hosts / sources / everything), or to ONE discovery mode - that lets two modes on the same axis split the estate: ' +
                   'e.g. include index=netdev* only for "sources by index+source" and exclude index=netdev* only for "sourcetypes by index+sourcetype". ' +
                   'Axis-scoped rules also trim the live status searches; mode-scoped rules apply at discovery.',
            sortKey: 'tracking_type',
            searchFields: ['field_name', 'pattern', 'mode', 'tracking_type', 'notes'],
            clearAfterAdd: ['pattern', 'notes'],
            columns: [
                { key: 'tracking_type', label: 'Applies to', edit: { type: 'select', options: FILTER_SCOPES },
                  render: function (r) { return FILTER_SCOPE_LABELS[r.tracking_type] || r.tracking_type; } },
                { key: 'field_name',    label: 'Field', edit: { type: 'select', options: ['index', 'host', 'source', 'sourcetype'] } },
                { key: 'mode',          label: 'Mode', edit: { type: 'select', options: ['include', 'exclude'] },
                  render: function (r) {
                      return el('span', 'carbide-chip ' + (r.mode === 'include' ? 'carbide-chip-ok' : 'carbide-chip-down'), r.mode);
                  } },
                { key: 'pattern',       label: 'Pattern', edit: { type: 'text', validate: function (v) { if (!v) return 'pattern is required'; } } },
                { key: 'notes',         label: 'Notes', edit: { type: 'text' } }
            ],
            addTitle: 'Add rule',
            addForm: [
                { key: 'tracking_type', label: 'Applies to', options: FILTER_SCOPES },
                { key: 'field_name', label: 'Field', options: ['index', 'host', 'source', 'sourcetype'] },
                { key: 'mode', label: 'Mode', options: [{ value: 'exclude', label: 'exclude (blacklist)' }, { value: 'include', label: 'include (whitelist)' }] },
                { key: 'pattern', label: 'Pattern (* and ? wildcards)', placeholder: 'e.g. wineventlog* or web0?' },
                { key: 'notes', label: 'Notes', placeholder: 'optional' }
            ],
            validate: function (d) { if (!d.pattern) return 'pattern is required'; },
            emptyText: 'No filter rules - discovery sees everything (minus the dedicated carbide index).'
        }
    };

    function validateHolidayDate(v, row) {
        var rec = Number(row.recurring);
        if (rec === 1  && !/^\d{2}-\d{2}$/.test(v))       return 'recurring dates must be MM-DD';
        if (rec !== 1 && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'fixed dates must be YYYY-MM-DD';
    }

    // =============================================================
    //  PAGE: manage_suggestions (oneshot search + apply)
    // =============================================================

    function suggestionsPage() {
        var state = {
            loaded: false,
            onlyDiff: true,
            search: '',
            data: { host: [], source: [] },
            sort: { key: 'entity_key', dir: 1 }
        };

        var AXES = [
            { id: 'host',   title: 'Hosts - suggestions',   macro: 'carbide_threshold_suggestions_hosts',   collection: 'carbide_tracked_hosts' },
            { id: 'source', title: 'Sources - suggestions', macro: 'carbide_threshold_suggestions_sources', collection: 'carbide_tracked_sources' }
        ];

        function filtered(rows) {
            var needle = state.search.trim().toLowerCase();
            return rows.filter(function (r) {
                if (needle && !contains(r.entity_key, needle)) return false;
                if (state.onlyDiff) {
                    var cl = Number(r.current_max_latency) || 1, cg = Number(r.current_max_gap) || 1;
                    var dl = Math.abs(Number(r.delta_max_latency) || 0) / cl;
                    var dg = Math.abs(Number(r.delta_max_gap) || 0) / cg;
                    if (dl <= 0.1 && dg <= 0.1) return false;
                }
                return true;
            });
        }

        function applyField(axis, rows, field, sourceField) {
            var candidates = rows.filter(function (r) { return Number(r[sourceField]) > 0 && r._key; });
            if (!candidates.length) { toast('no applicable rows', 'err'); return; }
            if (!confirm('Apply ' + sourceField + ' to ' + field + ' on ' + candidates.length + ' rows?')) return;
            // KV POST replaces the whole doc, so patch the full tracked rows.
            kvList(axis.collection).then(function (docs) {
                var byKey = {};
                (docs || []).forEach(function (d) { byKey[d._key] = d; });
                var ts = now();
                var updates = [];
                candidates.forEach(function (r) {
                    var doc = byKey[r._key];
                    if (!doc) return;
                    doc[field] = Number(r[sourceField]);
                    doc.last_updated = ts;
                    updates.push(doc);
                });
                if (!updates.length) throw new Error('no matching tracked rows');
                return batchSaveAll(axis.collection, updates).then(function () {
                    toast('applied to ' + updates.length + ' rows');
                });
            }).catch(function (e) { toast('apply failed: ' + e.message, 'err'); });
        }

        function numCol(key, label) {
            return { key: key, label: label, render: function (r) { var n = Number(r[key]); return isNaN(n) ? '-' : Math.round(n); } };
        }

        function render() {
            root.textContent = '';

            var intro = el('div', 'carbide-intro',
                'Proposed thresholds from the past 7 days of indexed metadata: suggested latency = P95 x 1.5, suggested gap = average event interval x 5. ' +
                'Positive delta = more lenient than today, negative = tighter. Review, then apply per column.');
            root.appendChild(intro);

            var bar = el('div', 'carbide-filters');
            bar.appendChild(labeled('Show', select(
                [{ value: 'diff', label: 'only rows differing by > 10%' }, { value: 'all', label: 'all rows' }],
                state.onlyDiff ? 'diff' : 'all', function (v) { state.onlyDiff = v === 'diff'; render(); })));
            bar.appendChild(labeled('Filter (contains)', textInput(state.search, 'entity...', function (v) { state.search = v; render(); })));
            bar.appendChild(btn('↻ Recompute', null, load));
            bar.appendChild(versionTag());
            root.appendChild(bar);

            if (!state.loaded) {
                root.appendChild(el('div', 'carbide-loading', 'Computing suggestions from the last 7 days… (runs two searches, this can take a moment)'));
                return;
            }

            AXES.forEach(function (axis) {
                var rows = filtered(state.data[axis.id]);
                root.appendChild(el('h3', 'carbide-h3', axis.title));
                root.appendChild(el('div', 'carbide-count', rows.length + ' of ' + state.data[axis.id].length + ' entities shown'));

                var cols = [
                    { key: 'entity_key', label: 'Entity',
                      render: function (r) {
                          var a = el('a', null, r.entity_key);
                          var target = axis.id;
                          if (target === 'source' && String(r.entity_key || '').indexOf('|sourcetype=') >= 0) target = 'sourcetype';
                          a.href = 'manage_entities?form.type_tok=' + target + '&form.search_tok=' + encodeURIComponent(r.entity_key || '');
                          return a;
                      } },
                    numCol('current_max_latency',   'Current latency (s)'),
                    numCol('suggested_max_latency', 'Suggested latency (s)'),
                    numCol('delta_max_latency',     'Δ latency'),
                    numCol('current_max_gap',       'Current gap (s)'),
                    numCol('suggested_max_gap',     'Suggested gap (s)'),
                    numCol('delta_max_gap',         'Δ gap'),
                    numCol('event_count',           'Events (7d)'),
                    numCol('p95_latency',           'P95 latency (s)'),
                    numCol('avg_interval',          'Avg interval (s)')
                ];

                root.appendChild(buildTable(cols, {
                    rows: rows,
                    sort: state.sort,
                    onSort: function (key) {
                        if (state.sort.key === key) state.sort.dir = -state.sort.dir;
                        else state.sort = { key: key, dir: 1 };
                        render();
                    },
                    onEdit: function () {},
                    emptyText: 'No suggestions - either nothing is monitored yet, or current thresholds already match the data.'
                }));

                var apply = el('div', 'carbide-actions');
                apply.appendChild(btn('Apply suggested latency to shown rows', null, function () {
                    applyField(axis, rows, 'max_latency_seconds', 'suggested_max_latency');
                }));
                apply.appendChild(btn('Apply suggested gap to shown rows', null, function () {
                    applyField(axis, rows, 'max_gap_seconds', 'suggested_max_gap');
                }));
                root.appendChild(apply);
            });
        }

        function load() {
            state.loaded = false;
            render();
            Promise.all(AXES.map(function (a) {
                return oneshot('| `' + a.macro + '`', '-7d@h', 'now');
            })).then(function (res) {
                state.data.host = res[0] || [];
                state.data.source = res[1] || [];
                state.loaded = true;
                render();
            }).catch(function (e) {
                root.textContent = '';
                root.appendChild(el('div', 'carbide-error', 'Suggestion search failed: ' + e.message));
            });
        }

        render();
        load();
    }

    // ------------------------------------------------------------- boot

    var booted = false;
    function boot() {
        if (booted) return;
        root = document.getElementById('carbide-manage');
        if (!root) return;
        booted = true;
        var page = root.getAttribute('data-page') || 'manage_entities';
        if (page === 'manage_entities')         entitiesPage();
        else if (page === 'manage_suggestions') suggestionsPage();
        else if (CRUD_PAGES[page])              crudPage(CRUD_PAGES[page]);
        else root.appendChild(el('div', 'carbide-error', 'Unknown page: ' + page));
    }
    // The host is a SimpleXML <html> panel that renders asynchronously,
    // so the root div may not exist yet when this script executes. Poll
    // briefly instead of assuming DOMContentLoaded is enough.
    document.addEventListener('DOMContentLoaded', boot);
    if (document.readyState !== 'loading') boot();
    var tries = 0;
    var poll = setInterval(function () {
        boot();
        if (booted || ++tries > 150) clearInterval(poll);
    }, 100);
})();
