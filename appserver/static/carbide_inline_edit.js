/**
 * Carbide for Splunk - inline KV-store editor
 * --------------------------------------------
 * Loaded by SimpleXML dashboards via the `script="carbide_inline_edit.js"`
 * attribute. Decorates tables that opt in via these data attributes:
 *
 *   data-carbide-collection           KV-store collection name (required)
 *   data-carbide-editable             CSV of header names that may be edited
 *   data-carbide-numeric              CSV of header names typed as numbers
 *   data-carbide-options-<field>      CSV of choices -> renders a <select>
 *   data-carbide-min-<field>          minimum numeric value (validation)
 *   data-carbide-max-<field>          maximum numeric value (validation)
 *   data-carbide-duration-fields      CSV of header names that take +Nh / +Nd
 *                                     duration syntax and preset selectors
 *                                     (e.g. "maintenance_from,maintenance_until")
 *
 * The table MUST include a column titled `_key` so we can address the row in
 * the KV store. We strip `_key` from the POSTed body since the URL carries it.
 *
 * Audit logging:
 *   Splunk auto-records every REST API call in index=_audit, including KV
 *   collection writes from inline edits. We don't generate our own audit
 *   events from the browser - the Settings dashboard surfaces the _audit
 *   query directly. That removes a fragile network call (and the implicit
 *   edit_tcp capability requirement of receivers/simple).
 *
 * Bulk updates:
 *   Use `storage/collections/data/<coll>/batch_save` so 1,000 rows are one
 *   POST instead of 2,000 round-trips. The handler reads the entire
 *   currently-visible row set in a single $in query, applies the field
 *   change in JS, then bulk-saves.
 */
require([
    'underscore',
    'jquery',
    'splunkjs/mvc',
    'splunkjs/mvc/utils',
    'splunkjs/mvc/simplexml/ready!'
], function (_, $, mvc, utils) {
    'use strict';

    var APP     = utils.getCurrentApp();
    var service = mvc.createService({ owner: 'nobody', app: APP });

    var MAINTENANCE_PRESETS = [
        { label: 'off',       offset: 0       },
        { label: '+15 min',   offset: 900     },
        { label: '+1 hour',   offset: 3600    },
        { label: '+4 hours',  offset: 14400   },
        { label: '+12 hours', offset: 43200   },
        { label: '+1 day',    offset: 86400   },
        { label: '+3 days',   offset: 259200  },
        { label: '+1 week',   offset: 604800  }
    ];

    // ---------------------------------------------------------------- toast

    function toast(msg, kind) {
        var $t = $('<div>')
            .addClass('carbide-toast carbide-toast-' + (kind || 'ok'))
            .text(msg)
            .appendTo('body');
        setTimeout(function () { $t.fadeOut(350, function () { $t.remove(); }); }, 2200);
    }

    // ---------------------------------------------------------------- REST helpers

    function kvPath(collection, key) {
        var base = '/servicesNS/nobody/' + APP + '/storage/collections/data/' + collection;
        return key ? base + '/' + encodeURIComponent(key) : base;
    }

    function kvBatchPath(collection) {
        return '/servicesNS/nobody/' + APP + '/storage/collections/data/' + collection + '/batch_save';
    }

    function kvPost(collection, key, body) {
        return new Promise(function (resolve, reject) {
            service.request(
                kvPath(collection, key),
                'POST',
                null,
                null,
                JSON.stringify(body),
                { 'Content-Type': 'application/json' },
                function (err, resp) { err ? reject(err) : resolve(resp); }
            );
        });
    }

    function kvCreate(collection, body)      { return kvPost(collection, null, body); }
    function kvUpdate(collection, key, body) { return kvPost(collection, key, _.omit(body, '_key')); }

    function kvGet(collection, key) {
        return new Promise(function (resolve, reject) {
            service.get(kvPath(collection, key), {}, function (err, resp) {
                if (err) return reject(err);
                try { resolve(JSON.parse(resp.data)); }
                catch (e) { resolve(resp.data); }
            });
        });
    }

    function kvQuery(collection, query) {
        return new Promise(function (resolve, reject) {
            service.get(kvPath(collection, null), { query: JSON.stringify(query) }, function (err, resp) {
                if (err) return reject(err);
                try { resolve(JSON.parse(resp.data)); }
                catch (e) { resolve([]); }
            });
        });
    }

    function kvBatchSave(collection, docs) {
        return new Promise(function (resolve, reject) {
            service.request(
                kvBatchPath(collection),
                'POST',
                null,
                null,
                JSON.stringify(docs),
                { 'Content-Type': 'application/json' },
                function (err, resp) { err ? reject(err) : resolve(resp); }
            );
        });
    }

    function kvDelete(collection, key) {
        return new Promise(function (resolve, reject) {
            service.del(kvPath(collection, key), {}, function (err, resp) {
                err ? reject(err) : resolve(resp);
            });
        });
    }

    // ---------------------------------------------------------------- search refresh

    function refreshTable(tableView) {
        if (!tableView) return;
        var smId = tableView.options && tableView.options.managerid;
        var sm = tableView.manager || (smId && mvc.Components.get(smId));
        if (sm && sm.startSearch) sm.startSearch();
    }

    // ---------------------------------------------------------------- validation

    function validate(field, value, meta) {
        if (meta.options[field]) {
            if (meta.options[field].indexOf(String(value)) < 0) {
                return field + ' must be one of: ' + meta.options[field].join(', ');
            }
        }
        if (meta.numeric.indexOf(field) >= 0) {
            var n = Number(value);
            if (isNaN(n)) return field + ' must be a number';
            if (meta.mins[field] !== undefined && n < meta.mins[field]) return field + ' must be >= ' + meta.mins[field];
            if (meta.maxs[field] !== undefined && n > meta.maxs[field]) return field + ' must be <= ' + meta.maxs[field];
        }
        return null;
    }

    // ---------------------------------------------------------------- duration parsing

    // "+1h" / "+30m" / "+2d" / "off" / "0" -> epoch seconds (0 = clear).
    // Also accepts a raw epoch number. Returns null on parse failure.
    function parseDurationToEpoch(input) {
        var s = String(input == null ? '' : input).trim().toLowerCase();
        if (s === '' || s === 'off' || s === '0') return 0;

        var m = /^\+?(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(s);
        if (m) {
            var n = parseFloat(m[1]);
            var unit = m[2];
            var mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
            return Math.floor(Date.now() / 1000) + n * mult;
        }
        var asNum = Number(s);
        if (!isNaN(asNum)) return asNum;
        return null;
    }

    // ---------------------------------------------------------------- decorate

    function readAttrs($el) {
        var editable = (('' + ($el.data('carbide-editable') || '')).split(',')
                            .map(function (s) { return s.trim(); }).filter(Boolean));
        var numeric  = (('' + ($el.data('carbide-numeric')  || '')).split(',')
                            .map(function (s) { return s.trim(); }).filter(Boolean));
        var durationFields = (('' + ($el.data('carbide-duration-fields') || $el.data('carbide-duration-field') || '')).split(',')
                            .map(function (s) { return s.trim(); }).filter(Boolean));
        var detailCols = (('' + ($el.data('carbide-detail-cols') || '')).split(',')
                            .map(function (s) { return s.trim(); }).filter(Boolean));
        var options  = {};
        var labels   = {};   // friendly column labels
        var mins     = {};
        var maxs     = {};
        _.each($el.get(0).attributes, function (attr) {
            var mOpt = attr.name.match(/^data-carbide-options-(.+)$/);
            var mLab = attr.name.match(/^data-carbide-label-(.+)$/);
            var mMin = attr.name.match(/^data-carbide-min-(.+)$/);
            var mMax = attr.name.match(/^data-carbide-max-(.+)$/);
            if (mOpt) {
                options[mOpt[1].replace(/-/g, '_')] = attr.value.split(',')
                    .map(function (s) { return s.trim(); }).filter(Boolean);
            }
            if (mLab) {
                labels[mLab[1].replace(/-/g, '_')] = attr.value;
            }
            if (mMin) {
                mins[mMin[1].replace(/-/g, '_')] = Number(attr.value);
            }
            if (mMax) {
                maxs[mMax[1].replace(/-/g, '_')] = Number(attr.value);
            }
        });
        return {
            editable: editable, numeric: numeric,
            options: options, labels: labels, detailCols: detailCols,
            mins: mins, maxs: maxs,
            durationFields: durationFields
        };
    }

    // ---------------------------------------------------------------- label + hide column decorators
    //
    // Friendly labels: each <th> with text matching a key in meta.labels gets
    // its visible text swapped; the original field name moves to data-original
    // so other JS can still look it up.
    //
    // Hide-by-token: the "show_details" token controls visibility of every
    // header named in meta.detailCols. We listen for token changes so toggling
    // the dropdown updates the table without re-running the search.

    function applyLabelsAndDetailVisibility($table, meta, showDetails) {
        $table.find('thead th').each(function (idx, th) {
            var $th = $(th);
            var original = $th.attr('data-carbide-original') || $th.text().trim();
            $th.attr('data-carbide-original', original);
            if (meta.labels[original]) {
                $th.text(meta.labels[original]);
                $th.attr('title', original);
            }
            // Apply visibility based on detail-col membership and toggle.
            var hide = (meta.detailCols.indexOf(original) >= 0) && !showDetails;
            $th.toggle(!hide);
            // Hide matching tds across all rows.
            $table.find('tbody tr').each(function (_, tr) {
                $(tr).children('td').eq(idx).toggle(!hide);
            });
        });
    }

    function currentShowDetails() {
        try {
            var tokens = mvc.Components.get('default');
            return tokens && tokens.get && tokens.get('show_details') === '1';
        } catch (e) { return false; }
    }

    function decorate(tableId) {
        var tableView = mvc.Components.get(tableId);
        if (!tableView) return;
        var $el = $('#' + tableId);
        if (!$el.length) return;

        var collection = $el.data('carbide-collection');
        if (!collection) return;

        var meta = readAttrs($el);

        var $table = $el.find('table').first();
        if (!$table.length) return;

        // Index columns by their ORIGINAL field name (data-carbide-original),
        // falling back to current text. We do this before relabeling so the
        // index always tracks the underlying field.
        var $headers = $table.find('thead th');
        var colIndex = {};
        $headers.each(function (i, th) {
            var $th = $(th);
            var name = $th.attr('data-carbide-original') || $th.text().trim();
            colIndex[name] = i;
        });

        // Apply friendly labels + show/hide detail columns.
        applyLabelsAndDetailVisibility($table, meta, currentShowDetails());

        var keyCol = colIndex['_key'];
        if (keyCol === undefined) return;

        $table.find('tbody tr').each(function (_rowIdx, tr) {
            var $tr = $(tr);
            var rowKey = $tr.find('td').eq(keyCol).text().trim();
            if (!rowKey) return;

            meta.editable.forEach(function (field) {
                var idx = colIndex[field];
                if (idx === undefined) return;
                var $td = $tr.find('td').eq(idx);
                if ($td.data('carbide-bound')) return;
                $td.data('carbide-bound', true);
                $td.addClass('carbide-editable');
                $td.attr('title', 'click to edit');

                $td.on('click', function (ev) {
                    if ($td.find('input, select').length) return;
                    ev.stopPropagation();

                    var original = $td.text().trim();
                    var $input;
                    var isDuration = meta.durationFields.indexOf(field) >= 0;

                    if (isDuration) {
                        $input = $('<select>').addClass('carbide-edit-input');
                        MAINTENANCE_PRESETS.forEach(function (p) {
                            $input.append($('<option>').val(p.offset === 0 ? '0' : '+' + p.offset).text(p.label));
                        });
                    } else if (meta.options[field]) {
                        $input = $('<select>').addClass('carbide-edit-input');
                        meta.options[field].forEach(function (opt) {
                            $input.append($('<option>').val(opt).text(opt));
                        });
                        $input.val(original);
                    } else if (meta.numeric.indexOf(field) >= 0) {
                        var minAttr = meta.mins[field];
                        var maxAttr = meta.maxs[field];
                        $input = $('<input>').addClass('carbide-edit-input').attr('type', 'number');
                        if (minAttr !== undefined) $input.attr('min', minAttr);
                        if (maxAttr !== undefined) $input.attr('max', maxAttr);
                        $input.val(original);
                    } else {
                        $input = $('<input>').addClass('carbide-edit-input').attr('type', 'text').val(original);
                    }
                    $td.empty().append($input);
                    $input.trigger('focus');
                    if ($input.is('input')) { $input[0].select(); }

                    var done = false;
                    function commit(cancel) {
                        if (done) return;
                        done = true;
                        if (cancel) { $td.text(original); return; }

                        var raw = $input.val();
                        var resolved;
                        if (isDuration) {
                            resolved = parseDurationToEpoch(raw);
                            if (resolved === null) { toast(field + ': use +1h, +30m, +1d or "off"', 'err'); $td.text(original); return; }
                        } else if (meta.numeric.indexOf(field) >= 0) {
                            resolved = Number(raw);
                        } else {
                            resolved = String(raw == null ? '' : raw).trim();
                        }

                        var validationErr = validate(field, resolved, meta);
                        if (validationErr) { toast(validationErr, 'err'); $td.text(original); return; }

                        if (String(resolved) === original) { $td.text(original); return; }

                        $td.text(String(resolved) + ' ...').addClass('carbide-saving');

                        kvGet(collection, rowKey).then(function (doc) {
                            if (!doc || typeof doc !== 'object') throw new Error('row not found');
                            doc[field] = resolved;
                            doc.last_updated = Math.floor(Date.now() / 1000);
                            return kvUpdate(collection, rowKey, doc);
                        }).then(function () {
                            $td.text(String(resolved)).removeClass('carbide-saving');
                            toast(field + ' updated', 'ok');
                            refreshTable(tableView);
                        }).catch(function (err) {
                            $td.text(original).removeClass('carbide-saving');
                            console.error('carbide save failed', err);
                            toast('save failed: ' + (err && err.message ? err.message : err), 'err');
                        });
                    }

                    $input.on('blur', function () { commit(false); });
                    $input.on('keydown', function (k) {
                        if (k.key === 'Enter')  { k.preventDefault(); $input.trigger('blur'); }
                        if (k.key === 'Escape') { commit(true); }
                    });
                });
            });
        });
    }

    // ---------------------------------------------------------------- bulk actions (one batch_save call site)
    //
    // Three UI patterns share one code path:
    //   * wireBulk         — free-text bulk row on Manage entities (single value, N rows)
    //   * wireQuickAction  — single-click preset buttons (single value, N rows)
    //   * wireApplyAll     — Threshold Suggestions (per-row value pulled from a table column)
    //
    // The kvBulkPatch helper does the only `kvQuery $or → mutate → kvBatchSave`
    // round-trip; each wrapper just decides which rows to write and how each
    // doc gets mutated.

    function visibleKeysOf($table) {
        var keyCol;
        $table.find('table thead th').each(function (i, th) {
            var name = $(th).attr('data-carbide-original') || $(th).text().trim();
            if (name === '_key') keyCol = i;
        });
        if (keyCol === undefined) return [];
        var keys = [];
        $table.find('table tbody tr').each(function (_, tr) {
            var k = $(tr).children('td').eq(keyCol).text().trim();
            if (k) keys.push(k);
        });
        return keys;
    }

    function visiblePairsOf($table, sourceColHeader) {
        var keyCol, srcCol;
        $table.find('table thead th').each(function (i, th) {
            var name = $(th).attr('data-carbide-original') || $(th).text().trim();
            if (name === '_key')          keyCol = i;
            if (name === sourceColHeader) srcCol = i;
        });
        if (keyCol === undefined || srcCol === undefined) return null;
        var pairs = [];
        $table.find('table tbody tr').each(function (_, tr) {
            var $tr = $(tr);
            var k = $tr.children('td').eq(keyCol).text().trim();
            var v = Number($tr.children('td').eq(srcCol).text().trim());
            if (k && !isNaN(v) && v > 0) pairs.push({ _key: k, value: v });
        });
        return pairs;
    }

    function kvBulkPatch(opts) {
        // opts: collection, keys, mutator, confirmMsg, button, tableView, toastOk, toastErr, onDone
        var keys = opts.keys || [];
        if (!keys.length) { toast('no rows in view', 'err'); return; }
        if (opts.confirmMsg && !window.confirm(opts.confirmMsg.replace('{n}', keys.length))) return;

        var $btn = opts.button;
        if ($btn) $btn.prop('disabled', true);

        return kvQuery(opts.collection, { '$or': keys.map(function (k) { return { _key: k }; }) })
            .then(function (docs) {
                if (!docs || !docs.length) throw new Error('no docs returned');
                var ts = Math.floor(Date.now() / 1000);
                docs.forEach(function (doc) {
                    opts.mutator(doc);
                    doc.last_updated = ts;
                });
                return kvBatchSave(opts.collection, docs).then(function () { return docs.length; });
            })
            .then(function (n) {
                if ($btn) $btn.prop('disabled', false);
                toast((opts.toastOk || 'applied to {n} rows').replace('{n}', n), 'ok');
                refreshTable(opts.tableView);
                if (opts.onDone) opts.onDone();
            })
            .catch(function (err) {
                if ($btn) $btn.prop('disabled', false);
                console.error('kvBulkPatch failed', err);
                toast((opts.toastErr || 'failed') + ': ' + (err && err.message ? err.message : err), 'err');
            });
    }

    // ---- wireBulk: free-text "set field = value on filtered rows" ----------
    function wireBulk($container) {
        var collection = $container.data('carbide-collection');
        var targetId   = $container.data('carbide-bulk-target');
        var $btn       = $container.find('.carbide-bulk-apply');
        var $fieldSel  = $container.find('.carbide-bulk-field');
        var $valInput  = $container.find('.carbide-bulk-value');
        var $count     = $container.find('.carbide-bulk-count');
        var $table     = $('#' + targetId);
        if (!$table.length || !collection) return;

        var meta      = readAttrs($table);
        var tableView = mvc.Components.get(targetId);

        function refreshCount() { $count.text(visibleKeysOf($table).length + ' rows in view'); }
        if (tableView) { tableView.on('rendered', refreshCount); setTimeout(refreshCount, 400); }

        $btn.on('click', function () {
            var field = $fieldSel.val();
            var raw   = $valInput.val();
            var resolved;
            if (meta.durationFields.indexOf(field) >= 0) {
                resolved = parseDurationToEpoch(raw);
                if (resolved === null) { toast(field + ': use +1h, +30m, +1d or "off"', 'err'); return; }
            } else if (meta.numeric.indexOf(field) >= 0) {
                resolved = Number(raw);
            } else {
                resolved = String(raw == null ? '' : raw).trim();
            }
            var verr = validate(field, resolved, meta);
            if (verr) { toast(verr, 'err'); return; }

            kvBulkPatch({
                collection: collection,
                keys:       visibleKeysOf($table),
                mutator:    function (doc) { doc[field] = resolved; },
                confirmMsg: 'Set ' + field + ' = ' + resolved + ' on {n} rows ?',
                button:     $btn,
                tableView:  tableView,
                toastOk:    'bulk update applied to {n} rows',
                toastErr:   'bulk update failed',
                onDone:     function () { $valInput.val(''); }
            });
        });
    }

    // ---- wireQuickAction: single-click preset buttons ----------------------
    function wireQuickAction($btn) {
        var collection = $btn.data('carbide-collection');
        var targetId   = $btn.data('carbide-target');
        var field      = $btn.data('carbide-field');
        var literal    = $btn.attr('data-carbide-value');
        var duration   = $btn.attr('data-carbide-duration');
        var confirmMsg = $btn.attr('data-carbide-confirm');
        var $table     = $('#' + targetId);
        if (!$table.length || !collection || !field) return;

        $btn.on('click', function () {
            var resolved;
            if (duration != null) {
                resolved = parseDurationToEpoch(duration);
                if (resolved === null) { toast('bad duration: ' + duration, 'err'); return; }
            } else if (literal != null) {
                var asNum = Number(literal);
                resolved = isNaN(asNum) ? literal : asNum;
            } else { toast('button missing value', 'err'); return; }

            kvBulkPatch({
                collection: collection,
                keys:       visibleKeysOf($table),
                mutator:    function (doc) { doc[field] = resolved; },
                confirmMsg: confirmMsg || ('Set ' + field + ' on {n} rows ?'),
                button:     $btn,
                tableView:  mvc.Components.get(targetId)
            });
        });
    }

    // ---- wireApplyAll: per-row value pulled from a table column ------------
    function wireApplyAll($container) {
        var collection  = $container.data('carbide-collection');
        var targetId    = $container.data('carbide-bulk-target');
        var targetField = $container.data('carbide-target-field');
        var sourceCol   = $container.data('carbide-source-column');
        var $btn        = $container.find('.carbide-apply-all');
        var $table      = $('#' + targetId);
        if (!$table.length || !collection || !targetField || !sourceCol) return;

        $btn.on('click', function () {
            var pairs = visiblePairsOf($table, sourceCol);
            if (pairs === null) { toast('column not found (' + sourceCol + ')', 'err'); return; }
            if (!pairs.length)  { toast('no valid rows in view', 'err'); return; }

            var valueMap = {};
            pairs.forEach(function (p) { valueMap[p._key] = p.value; });

            kvBulkPatch({
                collection: collection,
                keys:       pairs.map(function (p) { return p._key; }),
                mutator:    function (doc) {
                    if (valueMap[doc._key] !== undefined) doc[targetField] = valueMap[doc._key];
                },
                confirmMsg: 'Apply ' + sourceCol + ' → ' + targetField + ' on {n} rows ?',
                button:     $btn,
                tableView:  mvc.Components.get(targetId)
            });
        });
    }

    // ---------------------------------------------------------------- bootstrap

    var TABLE_IDS = [
        'carbide_tracked_hosts_table',
        'carbide_tracked_sources_table',
        'carbide_entity_filters_table',
        'carbide_settings_table',
        'carbide_threshold_hosts_table',
        'carbide_threshold_sources_table',
        'carbide_entities_table',
        'carbide_assets_table',
        'carbide_holidays_table'
    ];

    TABLE_IDS.forEach(function (id) {
        var tv = mvc.Components.get(id);
        if (!tv) return;
        tv.on('rendered', function () { decorate(id); });
        setTimeout(function () { decorate(id); }, 300);
    });

    // Re-apply visibility (without re-rendering) when the show_details token
    // changes -- avoids a search round-trip on every toggle.
    try {
        var defaultTokens = mvc.Components.get('default');
        if (defaultTokens && defaultTokens.on) {
            defaultTokens.on('change:show_details', function () {
                TABLE_IDS.forEach(function (id) {
                    var $tbl = $('#' + id).find('table').first();
                    if (!$tbl.length) return;
                    var meta = readAttrs($('#' + id));
                    applyLabelsAndDetailVisibility($tbl, meta, currentShowDetails());
                });
            });
        }
    } catch (e) { /* ignore */ }

    $('.carbide-bulk').each(function () { wireBulk($(this)); });
    $('.carbide-apply-all-wrap').each(function () { wireApplyAll($(this)); });
    $('.carbide-quick-btn').each(function () { wireQuickAction($(this)); });

    // ---------------------------------------------------------------- delete buttons

    $('button[id^="carbide_delete_button"]').on('click', function () {
        var $btn = $(this);
        var $inp = $btn.siblings('input[type="text"]').first();
        if (!$inp.length) return;
        var key        = ('' + $inp.val()).trim();
        var collection = $inp.data('carbide-collection');
        var targetId   = $inp.data('carbide-delete-target');
        if (!key)        { toast('paste a _key first', 'err'); return; }
        if (!collection) { toast('missing collection', 'err'); return; }
        if (!window.confirm('Delete ' + collection + ' row\n' + key + ' ?')) return;

        kvDelete(collection, key).then(function () {
            toast('deleted ' + key, 'ok');
            $inp.val('');
            if (targetId) refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            toast('delete failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });

    // ---------------------------------------------------------------- add entity filter

    $('#carbide_add_entity_filter').on('click', function () {
        var $btn = $(this);
        var collection = $btn.data('carbide-collection');
        var targetId   = $btn.data('carbide-target');
        var doc = {
            field_name:    $('#carbide_new_field_name').val(),
            pattern:       ('' + $('#carbide_new_pattern').val()).trim(),
            mode:          $('#carbide_new_mode').val(),
            tracking_type: $('#carbide_new_tracking_type').val(),
            notes:         ('' + $('#carbide_new_notes').val()).trim()
        };
        if (!doc.pattern) { toast('pattern is required', 'err'); return; }
        kvCreate(collection, doc).then(function () {
            toast('rule added', 'ok');
            $('#carbide_new_pattern').val('');
            $('#carbide_new_notes').val('');
            refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            toast('add failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });

    // ---------------------------------------------------------------- add asset

    $('#carbide_add_asset').on('click', function () {
        var $btn = $(this);
        var collection = $btn.data('carbide-collection');
        var targetId   = $btn.data('carbide-target');
        var doc = {
            host:          ('' + $('#carbide_new_asset_host').val()).trim(),
            criticality:   $('#carbide_new_asset_criticality').val(),
            owner:         ('' + $('#carbide_new_asset_owner').val()).trim(),
            business_unit: ('' + $('#carbide_new_asset_bu').val()).trim(),
            notes:         ('' + $('#carbide_new_asset_notes').val()).trim(),
            source:        'manual'
        };
        if (!doc.host) { toast('host is required', 'err'); return; }
        kvCreate(collection, doc).then(function () {
            toast('asset added', 'ok');
            $('#carbide_new_asset_host').val('');
            $('#carbide_new_asset_owner').val('');
            $('#carbide_new_asset_bu').val('');
            $('#carbide_new_asset_notes').val('');
            refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            toast('add failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });

    // ---------------------------------------------------------------- add holiday

    $('#carbide_add_holiday').on('click', function () {
        var $btn = $(this);
        var collection = $btn.data('carbide-collection');
        var targetId   = $btn.data('carbide-target');
        var doc = {
            date:      ('' + $('#carbide_new_holiday_date').val()).trim(),
            name:      ('' + $('#carbide_new_holiday_name').val()).trim(),
            recurring: Number($('#carbide_new_holiday_recurring').val()),
            notes:     ('' + $('#carbide_new_holiday_notes').val()).trim()
        };
        if (!doc.date) { toast('date is required', 'err'); return; }
        // Lightweight format validation. Recurring=1 -> MM-DD; recurring=0 -> YYYY-MM-DD.
        var ok = doc.recurring === 1
            ? /^\d{2}-\d{2}$/.test(doc.date)
            : /^\d{4}-\d{2}-\d{2}$/.test(doc.date);
        if (!ok) {
            toast(doc.recurring === 1 ? 'recurring date must be MM-DD' : 'fixed date must be YYYY-MM-DD', 'err');
            return;
        }
        kvCreate(collection, doc).then(function () {
            toast('holiday added', 'ok');
            $('#carbide_new_holiday_date').val('');
            $('#carbide_new_holiday_name').val('');
            $('#carbide_new_holiday_notes').val('');
            refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            toast('add failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });

    // ---------------------------------------------------------------- recommended defaults

    var RECOMMENDED_DEFAULTS = [
        { setting_key: 'default_monitored',            setting_value: '0'      },
        { setting_key: 'default_max_latency_seconds',  setting_value: '600'    },
        { setting_key: 'default_max_gap_seconds',      setting_value: '3600'   },
        { setting_key: 'default_monitoring_schedule',  setting_value: '247'    }
    ];

    $('#carbide_use_recommended_defaults').on('click', function () {
        var $btn = $(this);
        var collection = $btn.data('carbide-collection') || 'carbide_settings';
        var targetId   = $btn.data('carbide-target');

        if (!window.confirm('Set the four bootstrap defaults to recommended values?')) return;
        $btn.prop('disabled', true);

        // Fetch every existing row for these keys in one query, merge, then
        // batch_save. Rows without an _key become creates; rows with one
        // become updates - batch_save handles both atomically.
        kvQuery(collection, { '$or': RECOMMENDED_DEFAULTS.map(function (d) {
            return { setting_key: d.setting_key };
        }) }).then(function (rows) {
            var byKey = {};
            (rows || []).forEach(function (r) { byKey[r.setting_key] = r; });
            var docs = RECOMMENDED_DEFAULTS.map(function (d) {
                var existing = byKey[d.setting_key];
                return existing ? _.extend({}, existing, { setting_value: d.setting_value }) : d;
            });
            return kvBatchSave(collection, docs);
        }).then(function () {
            $btn.prop('disabled', false);
            toast('recommended defaults applied', 'ok');
            if (targetId) refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            $btn.prop('disabled', false);
            toast('failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });

    // ---------------------------------------------------------------- settings upsert

    $('#carbide_save_setting').on('click', function () {
        var $btn = $(this);
        var collection = $btn.data('carbide-collection');
        var targetId   = $btn.data('carbide-target');
        var key = $('#carbide_new_setting_key').val();
        var val = ('' + $('#carbide_new_setting_value').val()).trim();
        if (!key || val === '') { toast('key and value required', 'err'); return; }

        var doc = { setting_key: key, setting_value: val };

        kvQuery(collection, { setting_key: key }).then(function (rows) {
            var existing = rows && rows.length ? rows[0] : null;
            return existing && existing._key
                ? kvUpdate(collection, existing._key, doc)
                : kvCreate(collection, doc);
        }).then(function () {
            toast('setting saved', 'ok');
            $('#carbide_new_setting_value').val('');
            refreshTable(mvc.Components.get(targetId));
        }).catch(function (err) {
            toast('save failed: ' + (err && err.message ? err.message : err), 'err');
        });
    });
});
