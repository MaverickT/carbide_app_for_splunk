/**
 * Carbide App for Splunk - custom HTML views engine
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
    var VERSION = '2026-07-06.19';
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
            if (k.charAt(0) !== '_') out[k] = doc[k];   // _key, _user, our __coll tag
        });
        return out;
    }

    // Bulk delete: DELETE with a query param removes every matching doc.
    function kvDeleteKeys(coll, keys) {
        return chunked(keys).reduce(function (p, c) {
            return p.then(function () {
                var q = encodeURIComponent(JSON.stringify({ '$or': c.map(function (k) { return { _key: k }; }) }));
                return rest('DELETE', kvUrl(coll) + '?query=' + q);
            });
        }, Promise.resolve());
    }

    // ---- CSV export / import -------------------------------------------
    // Only these field NAMES are coerced to numbers on import (a blanket
    // "looks numeric" rule would corrupt string fields like patterns).
    var NUMERIC_FIELDS = {};
    ['monitored', 'max_latency_seconds', 'max_gap_seconds', 'min_volume_pct',
     'baseline_epc', 'first_seen', 'last_updated', 'last_event_time',
     'last_latency', 'maintenance_from', 'maintenance_until',
     'watch', 'recurring', 'reviewed', 'offhours_grace_seconds', 'on_hours_since'].forEach(function (f) { NUMERIC_FIELDS[f] = 1; });

    function toCsv(rows, fields) {
        function esc(v) {
            var s = v == null ? '' : String(v);
            return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }
        var out = [fields.map(esc).join(',')];
        rows.forEach(function (r) {
            out.push(fields.map(function (f) { return esc(r[f]); }).join(','));
        });
        return out.join('\r\n');
    }

    function downloadCsv(name, csv) {
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    function parseCsv(text) {
        var rows = [], row = [], cur = '', inQ = false;
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (inQ) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { cur += '"'; i++; }
                    else inQ = false;
                } else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === ',') { row.push(cur); cur = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(cur); cur = '';
                if (row.length > 1 || row[0] !== '') rows.push(row);
                row = [];
            } else cur += ch;
        }
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
        if (!rows.length) return [];
        var header = rows[0];
        return rows.slice(1).map(function (r) {
            var doc = {};
            header.forEach(function (h, idx) {
                var v = r[idx];
                if (v === undefined || v === '') return;
                doc[h] = NUMERIC_FIELDS[h] && !isNaN(Number(v)) ? Number(v) : v;
            });
            return doc;
        });
    }

    // Import docs into a collection: rows with _key are upserts, rows
    // without become new documents. `route(doc)` may return a different
    // collection per doc (Everything-axis exports carry _collection).
    function importCsvInto(defaultColl, route, onDone) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,text/csv';
        input.addEventListener('change', function () {
            var f = input.files && input.files[0];
            if (!f) return;
            var reader = new FileReader();
            reader.onload = function () {
                var docs;
                try { docs = parseCsv(String(reader.result)); }
                catch (e) { toast('could not parse CSV: ' + e.message, 'err'); return; }
                if (!docs.length) { toast('no rows in file', 'err'); return; }
                var groups = {};
                docs.forEach(function (d) {
                    var coll = (route && route(d)) || defaultColl;
                    delete d._collection;
                    delete d.__coll;
                    (groups[coll] = groups[coll] || []).push(d);
                });
                var updates = docs.filter(function (d) { return d._key; }).length;
                if (!confirm('Import ' + docs.length + ' rows (' + updates + ' updates by _key, ' +
                             (docs.length - updates) + ' new)?')) return;
                Object.keys(groups).reduce(function (p, coll) {
                    return p.then(function () { return batchSaveAll(coll, groups[coll]); });
                }, Promise.resolve()).then(function () {
                    toast('imported ' + docs.length + ' rows');
                    if (onDone) onDone();
                }).catch(function (e) { toast('import failed: ' + e.message, 'err'); });
            };
            reader.readAsText(f);
        });
        input.click();
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
            // Leading neutral choice: blur without picking must NOT commit
            // (the old default was 'off', which silently ended active
            // snoozes on a stray click).
            input = select([{ value: 'keep', label: '(keep as is)' }].concat(
                SNOOZE_PRESETS.map(function (p) { return { value: String(p.secs), label: p.label }; })));
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
            if (kind === 'select' && col.edit.numeric) {
                v = Number(input.value);
            } else if (kind === 'snooze') {
                if (input.value === 'keep') { onEdit(null); return; }
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
        LOW_VOLUME:{ label: '📉 Low volume',   cls: 'lowvol' },
        SETTLING:  { label: '🌅 Settling',     cls: 'settling' },
        MAINT:     { label: '🔧 Snoozed',     cls: 'maint' },
        OFF_HOURS: { label: '🌙 Off-hours',   cls: 'offhours' },
        NEW:       { label: '⏳ Waiting for first check', cls: 'new' }
    };

    // Three UI axes over two KV collections: the sources collection is
    // split by tracking_mode into "Sources" and "Sourcetypes".
    // Quote a value for use inside an SPL search expression.
    function splQuote(v) {
        return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    // Status only exists for watched entities; MAINT re-derived at read time.
    function entityStatus(r) {
        if (Number(r.monitored) !== 1) return 'UNWATCHED';
        var from = Number(r.maintenance_from) || 0;
        var until = Number(r.maintenance_until) || 0;
        if (from <= now() && until > now()) return 'MAINT';
        return r.last_status || 'NEW';
    }

    function statusChip(r) {
        var st = entityStatus(r);
        var meta = STATUS_META[st] || { label: st, cls: 'new' };
        var label = meta.label;
        if (st === 'UNWATCHED' && Number(r.reviewed) === 1) label = '– Dismissed';
        return el('span', 'carbide-chip carbide-chip-' + meta.cls, label);
    }

    var ENT_AXES = {
        all:        { all: true, noun: '',
                      discoverHint: 'the discovery searches' },
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
            selected: { all: new Set(), host: new Set(), source: new Set(), sourcetype: new Set() },
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
            var w = q.get('form.watching_tok');
            if (w === '1' || w === '0' || w === 'awaiting' || w === 'dismissed') state.watching = w;
        })();

        function axisRows() {
            var a = ENT_AXES[state.axis];
            if (a.all) return state.rows.carbide_tracked_hosts.concat(state.rows.carbide_tracked_sources);
            var list = state.rows[a.collection];
            return a.modeFilter ? list.filter(a.modeFilter) : list;
        }

        function rowColl(r) {
            return r.__coll || ENT_AXES[state.axis].collection;
        }

        // Unwatched rows would sit on bootstrap "NEW" forever - the shared
        // entityStatus() shows them as "Not watched" instead.
        function rowStatus(r) { return entityStatus(r); }

        var STALE_SECS = 30 * 86400;   // keep in sync with carbide_stale_after_seconds
        function isStale(r) {
            var last = Number(r.last_event_time) || Number(r.first_seen) || 0;
            return last > 0 && (now() - last) > STALE_SECS;
        }

        function filtered() {
            var needle = state.search.trim().toLowerCase();
            var tag = state.tag.trim().toLowerCase();
            var statuses = state.status === '*' || state.status === '__STALE__' ? null : state.status.split('|');
            return axisRows().filter(function (r) {
                if (state.watching === 'awaiting') {
                    if (Number(r.monitored) === 1 || Number(r.reviewed) === 1) return false;
                } else if (state.watching === 'dismissed') {
                    if (Number(r.monitored) === 1 || Number(r.reviewed) !== 1) return false;
                } else if (state.watching !== '*' && String(Number(r.monitored) || 0) !== state.watching) return false;
                if (state.status === '__STALE__' && !isStale(r)) return false;
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
            kvSave(rowColl(row), row).then(function () {
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
            var groups = {};
            rows.forEach(function (r) { (groups[rowColl(r)] = groups[rowColl(r)] || []).push(r); });
            Object.keys(groups).reduce(function (p, coll) {
                return p.then(function () { return batchSaveAll(coll, groups[coll]); });
            }, Promise.resolve()).then(function () {
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
                { key: 'status',              label: 'Status', sortVal: rowStatus, render: statusChip },
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
                { key: 'entity_key',          label: 'Entity',
                  render: function (r) {
                      var a = el('a', null, r.entity_key);
                      a.href = 'entity?k=' + encodeURIComponent(r._key || '') + '&c=' + encodeURIComponent(rowColl(r));
                      a.title = 'Open entity page';
                      return a;
                  } },
                { key: 'monitoring_schedule', label: 'Schedule', edit: { type: 'select', options: ['247', 'weekdays', 'business_hours'] },
                  render: function (r) { return r.monitoring_schedule || '247'; } },
                { key: 'tags',                label: 'Tags', edit: { type: 'text' } },
                { key: 'max_gap_seconds',     label: 'Alert if quiet for', edit: { type: 'duration' },
                  render: function (r) { return fmtDur(r.max_gap_seconds); },
                  title: function (r) { return (r.max_gap_seconds || 0) + ' s - click to edit (15m, 7h, 1d, 1w...)'; } },
                { key: 'max_latency_seconds', label: 'Alert if delayed by', edit: { type: 'duration' },
                  render: function (r) { return fmtDur(r.max_latency_seconds); },
                  title: function (r) { return (r.max_latency_seconds || 0) + ' s - click to edit (15m, 7h, 1d, 1w...)'; } },
                { key: 'min_volume_pct',      label: 'Alert if volume below', edit: { type: 'number', min: 0 },
                  render: function (r) { return Number(r.min_volume_pct) > 0 ? r.min_volume_pct + '% of normal' : '-'; },
                  title: function (r) {
                      return Number(r.baseline_epc) > 0
                          ? 'normal ≈ ' + Math.round(r.baseline_epc) + ' events/24h - 0 disables volume alerting'
                          : 'baseline still learning (needs a few snapshot cycles) - 0 disables';
                  } },
                { key: 'maintenance_until',   label: 'Snoozed until', edit: { type: 'snooze' },
                  render: function (r) { return fmtUntil(r.maintenance_until); },
                  title: function (r) { return fmtTs(r.maintenance_until); } },
                { key: 'last_event_time',     label: 'Last event / discovered', render: function (r) { return fmtTs(r.last_event_time); } },
                { key: 'maintenance_from',    label: 'Snooze from', detail: true, edit: { type: 'snooze' },
                  render: function (r) { return Number(r.maintenance_from) ? fmtTs(r.maintenance_from) : '-'; } },
                { key: 'tracking_mode',       label: 'Grouped by', detail: true,
                  edit: axis === 'host' ? { type: 'select', options: HOST_TRACKING_MODES } : undefined },
                { key: 'offhours_grace_seconds', label: 'Grace after reopen', detail: true, edit: { type: 'duration' },
                  render: function (r) { return Number(r.offhours_grace_seconds) > 0 ? fmtDur(r.offhours_grace_seconds) : 'default'; },
                  title: function (r) { return 'Only affects weekdays/business_hours entities. Blank/0 = the global default. Grace held after the schedule reopens before a stale gap fires.'; } },
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
                 { value: 'source', label: 'Sources' },
                 { value: 'all', label: 'Everything' }],
                state.axis, function (v) { state.axis = v; render(); })));
            bar.appendChild(labeled('Watching', select(
                [{ value: '*', label: 'All' },
                 { value: '1', label: 'On (watching)' },
                 { value: '0', label: 'Off (not watching)' },
                 { value: 'awaiting', label: 'Off - awaiting review' },
                 { value: 'dismissed', label: 'Off - dismissed' }],
                state.watching, function (v) { state.watching = v; render(); })));
            bar.appendChild(labeled('Status', select(
                [{ value: '*', label: 'All' },
                 { value: 'OK', label: 'Healthy' },
                 { value: 'LATE', label: 'Delayed' },
                 { value: 'DOWN|CRITICAL', label: 'Missing (DOWN / CRITICAL)' },
                 { value: 'MAINT', label: 'Snoozed' },
                 { value: 'OFF_HOURS', label: 'Off-hours' },
                 { value: 'LOW_VOLUME', label: 'Low volume' },
                 { value: 'SETTLING', label: 'Settling (schedule just reopened)' },
                 { value: 'NEW', label: 'Waiting for first check' },
                 { value: 'UNWATCHED', label: 'Not watched' },
                 { value: '__STALE__', label: 'Stale (no events 30d+)' }],
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
            actions.appendChild(btn('✓ Dismiss from review', null, function () { bulk(function (r) { r.reviewed = 1; }, 'Dismiss from review'); }));
            actions.appendChild(btn('↩ Return to review', null, function () { bulk(function (r) { r.reviewed = 0; }, 'Return to review'); }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('🔧 Snooze 1h', null, function () { bulk(function (r) { r.maintenance_until = now() + 3600; }, 'Snooze 1h'); }));
            actions.appendChild(btn('🔧 Snooze 1d', null, function () { bulk(function (r) { r.maintenance_until = now() + 86400; }, 'Snooze 1d'); }));
            actions.appendChild(btn('End snooze', null, function () { bulk(function (r) { r.maintenance_until = 0; }, 'End snooze'); }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('📅 24/7', null, function () { bulk(function (r) { r.monitoring_schedule = '247'; }, 'Set schedule 24/7'); }));
            actions.appendChild(btn('📅 Weekdays', null, function () { bulk(function (r) { r.monitoring_schedule = 'weekdays'; }, 'Set schedule weekdays'); }));
            actions.appendChild(btn('📅 Business hrs', null, function () { bulk(function (r) { r.monitoring_schedule = 'business_hours'; }, 'Set schedule business hours'); }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('🗑 Stop tracking', 'danger', function () {
                var pool = filtered();
                var sel = selectedRows(pool);
                var rows = sel.length ? sel : pool;
                var scope = sel.length ? rows.length + ' selected rows' : 'ALL ' + rows.length + ' filtered rows';
                if (!rows.length) { toast('no rows to act on', 'err'); return; }
                if (!confirm('DELETE ' + scope + ' from tracking? (KV rows are removed; data ingestion unaffected. Discovery will re-find live entities.)')) return;
                var groups = {};
                rows.forEach(function (r) { (groups[rowColl(r)] = groups[rowColl(r)] || []).push(r._key); });
                Object.keys(groups).reduce(function (p, coll) {
                    return p.then(function () { return kvDeleteKeys(coll, groups[coll]); });
                }, Promise.resolve()).then(function () {
                    toast('removed ' + rows.length + ' rows');
                    state.selected[state.axis].clear();
                    load();
                }).catch(function (e) { toast('bulk delete failed: ' + e.message, 'err'); load(); });
            }));
            actions.appendChild(el('span', 'carbide-sep'));
            actions.appendChild(btn('⬇ Export CSV', null, function () {
                var rows = filtered().map(function (r) {
                    var d = {}; Object.keys(r).forEach(function (k) { if (k !== '__coll') d[k] = r[k]; });
                    d._collection = rowColl(r);
                    return d;
                });
                if (!rows.length) { toast('nothing to export', 'err'); return; }
                var fields = ['_key', '_collection', 'entity_key', 'tracking_mode', 'index', 'host', 'source', 'sourcetype',
                              'monitored', 'monitoring_schedule', 'max_gap_seconds', 'max_latency_seconds', 'min_volume_pct',
                              'maintenance_from', 'maintenance_until', 'tags', 'notes',
                              'reviewed', 'offhours_grace_seconds', 'last_status', 'last_event_time', 'last_latency', 'baseline_epc', 'on_hours_since', 'first_seen', 'last_updated'];
                downloadCsv('carbide_entities.csv', toCsv(rows, fields));
            }));
            actions.appendChild(btn('⬆ Import CSV', null, function () {
                importCsvInto(ENT_AXES[state.axis].collection || 'carbide_tracked_hosts', function (d) {
                    return d._collection;
                }, load);
            }));
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
                (ENT_AXES[state.axis].noun ? ENT_AXES[state.axis].noun + ' ' : '') + 'entities' +
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
                    kvDelete(rowColl(r), r._key).then(function () {
                        var list = state.rows[rowColl(r)];
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
                state.rows.carbide_tracked_hosts.forEach(function (r) { r.__coll = 'carbide_tracked_hosts'; });
                state.rows.carbide_tracked_sources.forEach(function (r) { r.__coll = 'carbide_tracked_sources'; });
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
            bar.appendChild(btn('⬇ Export CSV', null, function () {
                var rows = filtered();
                if (!rows.length) { toast('nothing to export', 'err'); return; }
                var fields = ['_key'].concat(cfg.columns.map(function (c) { return c.key; }));
                downloadCsv(cfg.collection + '.csv', toCsv(rows, fields));
            }));
            bar.appendChild(btn('⬆ Import CSV', null, function () {
                importCsvInto(cfg.collection, null, load);
            }));
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
                var formErr = null;
                cfg.addForm.forEach(function (f) {
                    var v = addValue(f);
                    if (f.duration) {
                        var dv = String(v).trim();
                        if (dv === '' || dv === '0' || dv === '0s') return; // blank = keep defaults
                        var secs = parseDuration(dv);
                        if (secs === null || secs < 0) { formErr = f.label + ': use a duration like 15m, 7h, 1d (or leave blank)'; return; }
                        doc[f.key] = secs;
                        return;
                    }
                    doc[f.key] = f.numeric ? Number(v) : String(v).trim();
                });
                if (formErr) { toast(formErr, 'err'); return; }
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

    var AUTOWATCH_SCOPES = [
        { value: '*',                  label: 'everything' },
        { value: 'hosts|*',            label: 'hosts axis (every host mode)' },
        { value: 'sources|*',          label: 'sources axis (every source mode)' },
        { value: '*|index_host',       label: 'only: hosts by index+host' },
        { value: '*|host_source',      label: 'only: hosts by host+source' },
        { value: '*|host_sourcetype',  label: 'only: hosts by host+sourcetype' },
        { value: '*|index_sourcetype', label: 'only: sourcetypes by index+sourcetype' },
        { value: '*|index_source',     label: 'only: sources by index+source' }
    ];
    var AUTOWATCH_SCOPE_LABELS = {};
    AUTOWATCH_SCOPES.forEach(function (s) { AUTOWATCH_SCOPE_LABELS[s.value] = s.label; });

    var SCHEDULE_OPTIONS = [
        { value: '', label: 'keep default' },
        { value: '247', label: '24/7' },
        { value: 'weekdays', label: 'weekdays' },
        { value: 'business_hours', label: 'business hours' }
    ];

    var CRUD_PAGES = {
        manage_autowatch: {
            collection: 'carbide_autowatch_rules',
            intro: 'Auto-watch: when discovery finds a NEW entity whose scope and patterns all match a rule (wildcards * and ?), the rule is applied at insert time - start watching, set schedule, thresholds, tags. ' +
                   'Rules are NOT retroactive (existing entities are untouched - use Manage entities for those) and the FIRST matching rule wins, so keep rules disjoint. ' +
                   'Blank threshold or "keep default" schedule = the app defaults. The entity\'s Notes records which rule onboarded it.',
            sortKey: 'rule_name',
            searchFields: ['rule_name', 'index_pattern', 'host_pattern', 'source_pattern', 'sourcetype_pattern', 'tags', 'notes'],
            clearAfterAdd: ['rule_name', 'index_pattern', 'host_pattern', 'source_pattern', 'sourcetype_pattern', 'tags', 'notes'],
            columns: [
                { key: 'rule_name',          label: 'Rule', edit: { type: 'text', validate: function (v) { if (!v) return 'rule name is required'; } } },
                { key: 'scope_pattern',      label: 'Applies to', edit: { type: 'select', options: AUTOWATCH_SCOPES },
                  render: function (r) { return AUTOWATCH_SCOPE_LABELS[r.scope_pattern] || r.scope_pattern; } },
                { key: 'index_pattern',      label: 'Index matches', edit: { type: 'text' } },
                { key: 'host_pattern',       label: 'Host matches', edit: { type: 'text' } },
                { key: 'source_pattern',     label: 'Source matches', edit: { type: 'text' } },
                { key: 'sourcetype_pattern', label: 'Sourcetype matches', edit: { type: 'text' } },
                { key: 'watch',              label: 'Watch', edit: { type: 'select', options: ['1', '0'], numeric: true },
                  render: function (r) {
                      return el('span', 'carbide-chip ' + (Number(r.watch) === 1 ? 'carbide-chip-ok' : 'carbide-chip-new'),
                                Number(r.watch) === 1 ? 'Yes' : 'No');
                  } },
                { key: 'monitoring_schedule', label: 'Schedule', edit: { type: 'select', options: SCHEDULE_OPTIONS },
                  render: function (r) { return r.monitoring_schedule || 'keep default'; } },
                { key: 'max_gap_seconds',    label: 'Alert if quiet for', edit: { type: 'duration' },
                  render: function (r) { return Number(r.max_gap_seconds) > 0 ? fmtDur(r.max_gap_seconds) : 'keep default'; },
                  title: function (r) { return '0s = keep default'; } },
                { key: 'max_latency_seconds', label: 'Alert if delayed by', edit: { type: 'duration' },
                  render: function (r) { return Number(r.max_latency_seconds) > 0 ? fmtDur(r.max_latency_seconds) : 'keep default'; },
                  title: function (r) { return '0s = keep default'; } },
                { key: 'min_volume_pct',     label: 'Alert if volume below', edit: { type: 'number', min: 0 },
                  render: function (r) { return Number(r.min_volume_pct) > 0 ? r.min_volume_pct + '%' : 'keep default'; },
                  title: function (r) { return '0 = keep default (volume alerting off)'; } },
                { key: 'tags',               label: 'Tags', edit: { type: 'text' } },
                { key: 'notes',              label: 'Notes', edit: { type: 'text' } }
            ],
            addTitle: 'Add rule',
            addForm: [
                { key: 'rule_name', label: 'Rule name', placeholder: 'e.g. Windows prod servers' },
                { key: 'scope_pattern', label: 'Applies to', options: AUTOWATCH_SCOPES },
                { key: 'index_pattern', label: 'Index matches', placeholder: '* (any)' },
                { key: 'host_pattern', label: 'Host matches', placeholder: '* (any)' },
                { key: 'source_pattern', label: 'Source matches', placeholder: '* (any)' },
                { key: 'sourcetype_pattern', label: 'Sourcetype matches', placeholder: '* (any)' },
                { key: 'watch', label: 'Watch', numeric: true,
                  options: [{ value: '1', label: 'Yes - start watching' }, { value: '0', label: 'No - only apply settings' }] },
                { key: 'monitoring_schedule', label: 'Schedule', options: SCHEDULE_OPTIONS },
                { key: 'max_gap_seconds', label: 'Alert if quiet for', duration: true, placeholder: '7h, 1d... (blank = default)' },
                { key: 'max_latency_seconds', label: 'Alert if delayed by', duration: true, placeholder: '15m... (blank = default)' },
                { key: 'min_volume_pct', label: 'Alert if volume below (%)', numeric: true, value: '0', placeholder: '0 = off' },
                { key: 'tags', label: 'Tags', placeholder: 'prod, windows' },
                { key: 'notes', label: 'Notes', placeholder: 'optional' }
            ],
            validate: function (d) {
                if (!d.rule_name) return 'rule name is required';
                ['index_pattern', 'host_pattern', 'source_pattern', 'sourcetype_pattern'].forEach(function (k) {
                    if (!d[k]) d[k] = '*';
                });
            },
            emptyText: 'No auto-watch rules - newly discovered entities arrive unwatched with the app defaults.'
        },

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
            { id: 'source', title: 'Sources & sourcetypes - suggestions', macro: 'carbide_threshold_suggestions_sources', collection: 'carbide_tracked_sources' }
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
                          a.href = 'entity?entity_key=' + encodeURIComponent(r.entity_key || '');
                          a.title = 'Open entity page';
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

    // =============================================================
    //  PAGE: availability (heatmap + uptime %)
    // =============================================================

    function availabilityPage() {
        var state = { days: 30, loaded: false, rows: [], grid: {}, avail: {} };

        var SEV_META = {
            0: { cls: 'ok',   label: 'no incidents recorded' },
            1: { cls: 'quiet',label: 'snoozed / off-hours only' },
            2: { cls: 'warn', label: 'delayed or low volume' },
            3: { cls: 'bad',  label: 'missing data' }
        };

        function dayList() {
            var out = [];
            var d = new Date();
            d.setHours(0, 0, 0, 0);
            for (var i = state.days - 1; i >= 0; i--) {
                var x = new Date(d.getTime() - i * 86400000);
                function p(n) { return (n < 10 ? '0' : '') + n; }
                out.push(x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()));
            }
            return out;
        }

        function availClass(pct) {
            if (pct == null) return '';
            if (pct >= 99.9) return 'carbide-chip-ok';
            if (pct >= 99)   return 'carbide-chip-late';
            return 'carbide-chip-down';
        }

        function render() {
            root.textContent = '';

            root.appendChild(el('div', 'carbide-intro',
                'Per-entity availability over the selected window, computed from recorded transitions and heartbeats. ' +
                'Day cells show the WORST recorded state that day (empty = nothing recorded = presumed healthy while watched); ' +
                'availability % = time not spent in DOWN/CRITICAL. Watched entities only.'));

            var bar = el('div', 'carbide-filters');
            bar.appendChild(labeled('Window', select(
                [{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }],
                String(state.days), function (v) { state.days = Number(v); load(); })));
            bar.appendChild(btn('↻ Refresh', null, load));
            bar.appendChild(versionTag());
            root.appendChild(bar);

            if (!state.loaded) {
                root.appendChild(el('div', 'carbide-loading', 'Computing availability… (two searches over the carbide index)'));
                return;
            }

            var days = dayList();
            var rows = state.rows.slice().sort(function (a, b) {
                var x = state.avail[a.entity_key], y = state.avail[b.entity_key];
                x = x ? x.availability : 100; y = y ? y.availability : 100;
                if (x !== y) return x - y;
                return a.entity_key < b.entity_key ? -1 : 1;
            });

            root.appendChild(el('div', 'carbide-count',
                rows.length + ' watched entities - days run oldest → newest, worst recorded state per day'));

            var wrap = el('div', 'carbide-tablewrap');
            var table = el('table', 'carbide-table carbide-availtable');
            var htr = el('tr');
            htr.appendChild(el('th', null, 'Entity'));
            htr.appendChild(el('th', null, 'Availability'));
            htr.appendChild(el('th', null, 'Downtime'));
            days.forEach(function (d, i) {
                var th = el('th', 'carbide-dayhead', (d.slice(8) === '01' || i === 0) ? d.slice(5) : '');
                th.title = d;
                htr.appendChild(th);
            });
            var thead = el('thead');
            thead.appendChild(htr);
            table.appendChild(thead);

            var tbody = el('tbody');
            if (!rows.length) {
                var tr0 = el('tr');
                var td0 = el('td', 'carbide-empty', 'No watched entities yet.');
                td0.colSpan = days.length + 3;
                tr0.appendChild(td0);
                tbody.appendChild(tr0);
            }
            rows.forEach(function (r) {
                var tr = el('tr');
                var tdE = el('td');
                var a = el('a', null, r.entity_key);
                a.href = 'entity?k=' + encodeURIComponent(r._key || '') + '&c=' + encodeURIComponent(r.__coll || '');
                tdE.appendChild(a);
                tr.appendChild(tdE);

                var av = state.avail[r.entity_key];
                var tdA = el('td');
                if (av) {
                    tdA.appendChild(el('span', 'carbide-chip ' + availClass(av.availability), av.availability + '%'));
                } else {
                    tdA.appendChild(el('span', 'carbide-chip carbide-chip-new', '100%*'));
                    tdA.title = 'no events recorded in the window - presumed up while watched';
                }
                tr.appendChild(tdA);
                tr.appendChild(el('td', null, av && av.downtime > 0 ? fmtDur(av.downtime) : '-'));

                var cells = state.grid[r.entity_key] || {};
                var firstSeenDay = Number(r.first_seen) ? fmtTs(r.first_seen).slice(0, 10) : null;
                days.forEach(function (d) {
                    var td = el('td', 'carbide-day');
                    if (firstSeenDay && d < firstSeenDay) {
                        td.classList.add('carbide-day-na');
                        td.title = d + ' - before first seen';
                    } else {
                        var sev = cells[d];
                        var meta = SEV_META[sev === undefined ? 0 : sev];
                        td.classList.add('carbide-day-' + meta.cls);
                        td.title = d + ' - ' + meta.label;
                    }
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            wrap.appendChild(table);
            root.appendChild(wrap);
        }

        function load() {
            state.loaded = false;
            render();
            var earliest = '-' + state.days + 'd@d';
            var gridSpl = 'search index=`carbide_index` sourcetype="carbide:status"' +
                ' | eval sev = case(status="CRITICAL" OR status="DOWN", 3, status="LATE" OR status="LOW_VOLUME", 2, status="MAINT" OR status="OFF_HOURS" OR status="SETTLING", 1, 1=1, 0)' +
                ' | bin _time span=1d' +
                ' | eval day = strftime(_time, "%Y-%m-%d")' +
                ' | stats max(sev) as sev by entity_key, day';
            var availSpl = 'search index=`carbide_index` sourcetype="carbide:status"' +
                ' | sort 0 entity_key, _time' +
                ' | streamstats current=false last(_time) as prev_time, last(status) as prev_status by entity_key' +
                ' | addinfo' +
                ' | eval ws = coalesce(info_min_time, 0)' +
                ' | eval dwell_start = coalesce(prev_time, ws)' +
                ' | eval dwell_status = coalesce(prev_status, coalesce(previous_status, "NEW"))' +
                ' | eval dwell = _time - dwell_start' +
                ' | eval down = if(dwell > 0 AND (dwell_status="DOWN" OR dwell_status="CRITICAL"), dwell, 0)' +
                ' | stats sum(down) as downtime, max(_time) as last_t, latest(status) as last_status, min(ws) as ws by entity_key' +
                ' | eval downtime = downtime + if(last_status="DOWN" OR last_status="CRITICAL", now() - last_t, 0)' +
                ' | eval availability = max(0, round(100 * (1 - downtime / (now() - ws)), 2))' +
                ' | table entity_key, availability, downtime';
            Promise.all([
                kvList('carbide_tracked_hosts'),
                kvList('carbide_tracked_sources'),
                oneshot(gridSpl, earliest, 'now'),
                oneshot(availSpl, earliest, 'now')
            ]).then(function (res) {
                var hosts = (res[0] || []); hosts.forEach(function (r) { r.__coll = 'carbide_tracked_hosts'; });
                var sources = (res[1] || []); sources.forEach(function (r) { r.__coll = 'carbide_tracked_sources'; });
                state.rows = hosts.concat(sources).filter(function (r) { return Number(r.monitored) === 1; });
                state.grid = {};
                (res[2] || []).forEach(function (c) {
                    (state.grid[c.entity_key] = state.grid[c.entity_key] || {})[c.day] = Number(c.sev);
                });
                state.avail = {};
                (res[3] || []).forEach(function (a) {
                    state.avail[a.entity_key] = { availability: Number(a.availability), downtime: Number(a.downtime) || 0 };
                });
                state.loaded = true;
                render();
            }).catch(function (e) {
                root.textContent = '';
                root.appendChild(el('div', 'carbide-error', 'Availability computation failed: ' + e.message));
            });
        }

        render();
        load();
    }

    // =============================================================
    //  PAGE: entity (detail / drilldown target)
    // =============================================================

    function entityPage() {
        var q = new URLSearchParams(location.search);
        var wantKey    = q.get('k');
        var wantColl   = q.get('c');
        var wantEntity = q.get('entity_key') || q.get('form.entity_key');

        var row = null, coll = null;

        function saveField(change) {
            if (!change) { renderMain(); return; }
            var prev = row[change.field];
            row[change.field] = change.value;
            row.last_updated = now();
            kvSave(coll, row).then(function () {
                toast(change.field + ' saved');
                renderMain();
            }).catch(function (e) {
                row[change.field] = prev;
                toast('save failed: ' + e.message, 'err');
                renderMain();
            });
        }

        function setField(field, value) { saveField({ row: row, field: field, value: value }); }

        function kvRow(label, valueNode, colDef) {
            var r = el('div', 'carbide-kv-row');
            r.appendChild(el('span', 'carbide-kv-label', label));
            var v = el('span', 'carbide-kv-value');
            if (valueNode instanceof Node) v.appendChild(valueNode);
            else v.textContent = valueNode == null ? '-' : String(valueNode);
            if (colDef) {
                v.classList.add('editable');
                v.title = 'click to edit';
                v.addEventListener('click', function () { beginEdit(v, row, colDef, saveField); });
            }
            r.appendChild(v);
            return r;
        }

        function box(title) {
            var b = el('div', 'carbide-box');
            b.appendChild(el('h3', 'carbide-h3', title));
            return b;
        }

        function resultsTable(headers, rows) {
            var wrap = el('div', 'carbide-tablewrap');
            var table = el('table', 'carbide-table');
            var thead = el('thead');
            var htr = el('tr');
            headers.forEach(function (h) { htr.appendChild(el('th', null, h.label)); });
            thead.appendChild(htr);
            table.appendChild(thead);
            var tbody = el('tbody');
            if (!rows.length) {
                var tr0 = el('tr');
                var td0 = el('td', 'carbide-empty', 'Nothing in this window.');
                td0.colSpan = headers.length;
                tr0.appendChild(td0);
                tbody.appendChild(tr0);
            }
            rows.forEach(function (r) {
                var tr = el('tr');
                headers.forEach(function (h) {
                    var td = el('td');
                    if (h.raw) td.classList.add('carbide-raw');
                    var v = r[h.key];
                    td.textContent = v == null || v === '' ? '-' : String(v);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            wrap.appendChild(table);
            return wrap;
        }

        var main, historyBox, eventsBox;

        function renderMain() {
            main.textContent = '';

            // header: back link, title, status, actions
            var head = el('div', 'carbide-entity-head');
            var back = el('a', 'carbide-back', '← Manage entities');
            back.href = 'manage_entities';
            head.appendChild(back);
            head.appendChild(el('h2', 'carbide-entity-title', row.entity_key));
            head.appendChild(statusChip(row));

            var on = Number(row.monitored) === 1;
            var watch = el('button', 'carbide-watch ' + (on ? 'on' : 'off'), on ? 'Watching: On' : 'Watching: Off');
            watch.addEventListener('click', function () { setField('monitored', on ? 0 : 1); });
            head.appendChild(watch);

            head.appendChild(btn('🔧 Snooze 1h', null, function () { setField('maintenance_until', now() + 3600); }));
            head.appendChild(btn('🔧 Snooze 1d', null, function () { setField('maintenance_until', now() + 86400); }));
            if (Number(row.maintenance_until) > now()) {
                head.appendChild(btn('End snooze', null, function () { setField('maintenance_until', 0); }));
            }
            head.appendChild(btn('🗑 Stop tracking', 'danger', function () {
                if (!confirm('Stop tracking ' + row.entity_key + ' ? (KV row is deleted; data ingestion unaffected)')) return;
                kvDelete(coll, row._key).then(function () {
                    toast('removed');
                    location.href = 'manage_entities';
                }).catch(function (e) { toast('delete failed: ' + e.message, 'err'); });
            }));
            main.appendChild(head);

            var cols = el('div', 'carbide-cols');

            var cfg = box('Configuration (click a value to edit)');
            cfg.appendChild(kvRow('Schedule', row.monitoring_schedule || '247',
                { key: 'monitoring_schedule', label: 'Schedule', edit: { type: 'select', options: ['247', 'weekdays', 'business_hours'] } }));
            cfg.appendChild(kvRow('Alert if quiet for', fmtDur(row.max_gap_seconds),
                { key: 'max_gap_seconds', label: 'Alert if quiet for', edit: { type: 'duration' } }));
            cfg.appendChild(kvRow('Alert if delayed by', fmtDur(row.max_latency_seconds),
                { key: 'max_latency_seconds', label: 'Alert if delayed by', edit: { type: 'duration' } }));
            cfg.appendChild(kvRow('Alert if volume below',
                Number(row.min_volume_pct) > 0 ? row.min_volume_pct + '% of normal' : 'off (0)',
                { key: 'min_volume_pct', label: 'Alert if volume below (%)', edit: { type: 'number', min: 0 } }));
            cfg.appendChild(kvRow('Grace after schedule reopens',
                Number(row.offhours_grace_seconds) > 0 ? fmtDur(row.offhours_grace_seconds) : 'global default',
                { key: 'offhours_grace_seconds', label: 'Grace after reopen', edit: { type: 'duration' } }));
            cfg.appendChild(kvRow('Snooze from', Number(row.maintenance_from) ? fmtTs(row.maintenance_from) : '-',
                { key: 'maintenance_from', label: 'Snooze from', edit: { type: 'snooze' } }));
            cfg.appendChild(kvRow('Snoozed until', fmtUntil(row.maintenance_until),
                { key: 'maintenance_until', label: 'Snoozed until', edit: { type: 'snooze' } }));
            cfg.appendChild(kvRow('Tags', row.tags || '-', { key: 'tags', label: 'Tags', edit: { type: 'text' } }));
            cfg.appendChild(kvRow('Notes', row.notes || '-', { key: 'notes', label: 'Notes', edit: { type: 'text' } }));
            if (coll === 'carbide_tracked_hosts') {
                cfg.appendChild(kvRow('Grouped by', row.tracking_mode,
                    { key: 'tracking_mode', label: 'Grouped by', edit: { type: 'select', options: HOST_TRACKING_MODES } }));
            } else {
                cfg.appendChild(kvRow('Grouped by', row.tracking_mode));
            }
            cols.appendChild(cfg);

            var det = box('Details');
            det.appendChild(kvRow('Index', row.index));
            det.appendChild(kvRow('Host', row.host));
            det.appendChild(kvRow('Source', row.source));
            det.appendChild(kvRow('Sourcetype', row.sourcetype));
            det.appendChild(kvRow('Last event seen', fmtTs(row.last_event_time)));
            det.appendChild(kvRow('Ingest delay at last snapshot', fmtDur(row.last_latency)));
            det.appendChild(kvRow('Normal volume (learned baseline)',
                Number(row.baseline_epc) > 0 ? Math.round(row.baseline_epc) + ' events / 24h' : 'still learning'));
            det.appendChild(kvRow('First seen', fmtTs(row.first_seen)));
            det.appendChild(kvRow('Last updated', fmtTs(row.last_updated)));
            cols.appendChild(det);

            main.appendChild(cols);
            main.appendChild(historyBox);
            main.appendChild(eventsBox);
        }

        // Colored 7-day bar: one segment per interval between recorded
        // events (the segment carries the status that was IN EFFECT during
        // it), extended to "now" with the latest status. Gray = before the
        // first recorded event (status unknown).
        function buildTimeline(rows) {
            var winStart = (now() - 7 * 86400) * 1000;
            var winEnd = Date.now();
            var span = winEnd - winStart;
            var bar = el('div', 'carbide-timeline');
            function seg(from, to, status, hint) {
                if (to <= from) return;
                var meta = STATUS_META[status];
                var d = el('div', 'carbide-seg carbide-seg-' + (meta ? meta.cls : 'unknown'));
                d.style.width = ((to - from) / span * 100) + '%';
                d.title = (meta ? meta.label : (status || 'unknown')) +
                          ': ' + fmtTs(from / 1000) + ' → ' + fmtTs(to / 1000) +
                          ' (' + fmtDur((to - from) / 1000) + ')' + (hint ? ' - ' + hint : '');
                bar.appendChild(d);
            }
            var pts = rows.map(function (r) {
                return { t: Date.parse(r._time), status: r.status };
            }).filter(function (p) { return !isNaN(p.t) && p.t >= winStart; });
            if (!pts.length) {
                seg(winStart, winEnd, entityStatus(row), 'no recorded changes in this window');
            } else {
                seg(winStart, pts[0].t, rows[0].previous_status || 'unknown', 'before first recorded event');
                for (var i = 0; i < pts.length; i++) {
                    seg(pts[i].t, i + 1 < pts.length ? pts[i + 1].t : winEnd, pts[i].status);
                }
            }
            var wrap = el('div');
            wrap.appendChild(bar);
            var axis = el('div', 'carbide-timeline-axis');
            axis.appendChild(el('span', null, fmtTs(winStart / 1000)));
            axis.appendChild(el('span', null, 'now'));
            wrap.appendChild(axis);
            return wrap;
        }

        function loadHistory() {
            historyBox.textContent = '';
            historyBox.appendChild(el('h3', 'carbide-h3', 'Status history (7 days: transitions + hourly non-OK heartbeats)'));
            historyBox.appendChild(el('div', 'carbide-loading', 'Searching the carbide index…'));
            var spl = 'search index=`carbide_index` sourcetype="carbide:status" entity_key=' + splQuote(row.entity_key) +
                      ' | sort 0 _time' +
                      ' | eval when = strftime(_time, "%Y-%m-%d %H:%M:%S")' +
                      ' | eval kind = if(event_kind == "heartbeat", "heartbeat", "transition")' +
                      ' | table _time, when, kind, previous_status, status, current_gap, current_latency';
            oneshot(spl, '-7d@h', 'now').then(function (rows) {
                historyBox.textContent = '';
                historyBox.appendChild(el('h3', 'carbide-h3', 'Status history (7 days: transitions + hourly non-OK heartbeats)'));
                historyBox.appendChild(buildTimeline(rows));
                historyBox.appendChild(resultsTable([
                    { key: 'when', label: 'When' },
                    { key: 'kind', label: 'Kind' },
                    { key: 'previous_status', label: 'From' },
                    { key: 'status', label: 'To / status' },
                    { key: 'current_gap', label: 'Gap (s)' },
                    { key: 'current_latency', label: 'Delay (s)' }
                ], rows.slice(-50).reverse()));
            }).catch(function (e) {
                historyBox.appendChild(el('div', 'carbide-error', 'History search failed: ' + e.message));
            });
        }

        function loadEvents() {
            eventsBox.textContent = '';
            eventsBox.appendChild(el('h3', 'carbide-h3', 'Latest raw events (last 24h, max 20)'));
            eventsBox.appendChild(el('div', 'carbide-loading', 'Fetching events…'));
            var terms = [];
            ['index', 'host', 'source', 'sourcetype'].forEach(function (f) {
                var v = row[f];
                if (v != null && v !== '' && v !== '*') terms.push(f + '=' + splQuote(v));
            });
            // Without a positive index term Splunk searches only the role's
            // DEFAULT indexes (same trap as the entity-filter live bug) -
            // entities tracked with index="*" must explicitly say index=*.
            if (!terms.some(function (s) { return s.indexOf('index=') === 0; })) terms.unshift('index=*');
            var spl = 'search ' + terms.join(' ') +
                      ' | sort - _time | head 20' +
                      ' | eval when = strftime(_time, "%Y-%m-%d %H:%M:%S")' +
                      ' | table when, index, host, sourcetype, source, _raw';
            oneshot(spl, '-24h@h', 'now').then(function (rows) {
                eventsBox.textContent = '';
                eventsBox.appendChild(el('h3', 'carbide-h3', 'Latest raw events (last 24h, max 20)'));
                eventsBox.appendChild(resultsTable([
                    { key: 'when', label: 'When' },
                    { key: 'index', label: 'Index' },
                    { key: 'host', label: 'Host' },
                    { key: 'sourcetype', label: 'Sourcetype' },
                    { key: 'source', label: 'Source' },
                    { key: '_raw', label: 'Event', raw: true }
                ], rows));
            }).catch(function (e) {
                eventsBox.appendChild(el('div', 'carbide-error', 'Event search failed: ' + e.message));
            });
        }

        function start() {
            main = el('div');
            historyBox = el('div', 'carbide-box carbide-box-wide');
            eventsBox = el('div', 'carbide-box carbide-box-wide');
            root.textContent = '';
            root.appendChild(main);
            renderMain();
            loadHistory();
            loadEvents();
        }

        function fail(msg) {
            root.textContent = '';
            var e = el('div', 'carbide-error', msg);
            root.appendChild(e);
            var back = el('a', 'carbide-back', '← Manage entities');
            back.href = 'manage_entities';
            root.appendChild(back);
        }

        if (wantKey && wantColl) {
            rest('GET', kvUrl(wantColl, wantKey)).then(function (doc) {
                if (!doc || !doc._key) throw new Error('row not found');
                row = doc; coll = wantColl;
                start();
            }).catch(function () { resolveByEntityKey(); });
        } else {
            resolveByEntityKey();
        }

        function resolveByEntityKey() {
            if (!wantEntity && !wantKey) { fail('No entity specified.'); return; }
            Promise.all([kvList('carbide_tracked_hosts'), kvList('carbide_tracked_sources')]).then(function (res) {
                var pools = [['carbide_tracked_hosts', res[0] || []], ['carbide_tracked_sources', res[1] || []]];
                for (var i = 0; i < pools.length; i++) {
                    var hit = pools[i][1].filter(function (r) {
                        return (wantEntity && r.entity_key === wantEntity) || (wantKey && r._key === wantKey);
                    })[0];
                    if (hit) { row = hit; coll = pools[i][0]; start(); return; }
                }
                fail('Entity not found: ' + (wantEntity || wantKey) + ' - it may have been deleted or renamed.');
            }).catch(function (e) { fail('Could not load collections: ' + e.message); });
        }
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
        else if (page === 'entity')             entityPage();
        else if (page === 'availability')       availabilityPage();
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
