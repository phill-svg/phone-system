import { renderLayout } from "../layout";
import type { IvrNode } from "../../db/ivrNodes";

// Embeds a value as a JSON literal inside a <script> block. Guards against a stray
// "</script>" inside e.g. an uploaded audio-asset label or a node's ttsText breaking out
// of the script tag early.
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Version resolved from `npm view drawflow version` at the time this file was written
// (2026-08-10) and cross-checked against jerosoler/Drawflow's README + src/drawflow.js on
// GitHub to confirm addNode/addConnection/on()/module property names below still match.
const DRAWFLOW_VERSION = "0.0.60";
const DRAWFLOW_CSS_URL = `https://cdn.jsdelivr.net/npm/drawflow@${DRAWFLOW_VERSION}/dist/drawflow.min.css`;
const DRAWFLOW_JS_URL = `https://cdn.jsdelivr.net/npm/drawflow@${DRAWFLOW_VERSION}/dist/drawflow.min.js`;

export function renderIvrFlowPage(
  flow: string,
  nodes: IvrNode[],
  audioAssets: { id: string; label: string }[]
): string {
  const extraHead = `<link rel="stylesheet" href="${DRAWFLOW_CSS_URL}">
    <style>
      #canvas-wrap { position: relative; height: calc(100vh - 64px); }
      #drawflow { width: 100%; height: 100%; background: #f8f9fa; }
      #cdn-error { display: none; padding: 1rem; background: #fde8e8; color: #9b1c1c; }
      .ivr-node { border: 2px solid #1a3d2e; border-radius: 6px; background: white; padding: 0.5rem 0.75rem; min-width: 140px; cursor: pointer; }
      .ivr-node-id { font-weight: 600; font-size: 0.85rem; }
      .ivr-node-type { font-size: 0.75rem; color: #6b7280; }
      .ivr-node-external { border-style: dashed; opacity: 0.75; cursor: default; }
      #edit-panel { display: none; position: fixed; top: 0; right: 0; width: 380px; height: 100vh; background: white; border-left: 1px solid #ccc; padding: 1rem; overflow-y: auto; box-shadow: -2px 0 8px rgba(0,0,0,0.1); z-index: 10; }
      #edit-panel.open { display: block; }
    </style>`;

  const body = `<div id="cdn-error">Could not load the flow editor library. Check your connection and reload the page.</div>
    <div id="canvas-wrap">
      <div id="drawflow"></div>
    </div>
    <div id="edit-panel">
      <button type="button" id="close-panel-btn">Close</button>
      <div id="edit-panel-fields"></div>
      <p><button type="button" id="save-node-btn">Save node</button> <span id="save-status"></span></p>
    </div>

    <h3>Upload audio</h3>
    <form id="audio-upload-form">
      <input type="file" id="audio-file-input" name="file" required>
      <input type="text" id="audio-label-input" name="label" placeholder="Label">
      <button type="submit">Upload</button>
      <span id="audio-upload-status"></span>
    </form>
    <div id="audio-asset-list"></div>

    <script src="${DRAWFLOW_JS_URL}" onerror="document.getElementById('cdn-error').style.display='block'"></script>
    <script>
      var FLOW = ${safeJsonForScript(flow)};
      var currentNodes = ${safeJsonForScript(nodes)};
      var audioAssets = ${safeJsonForScript(audioAssets)};
      var entryNodeId = (currentNodes.filter(function (n) { return n.isEntry; })[0] || {}).id || null;
      var editor = null;
      var drawflowIdToIvrId = {};
      var ivrIdToDrawflowId = {};
      var editingIvrId = null;

      function escAttr(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      function escText(s) {
        return escAttr(s);
      }

      function audioOptionsHtml(selectedId) {
        var html = '<option value="">(none)</option>';
        audioAssets.forEach(function (a) {
          var sel = a.id === selectedId ? ' selected' : '';
          html += '<option value="' + escAttr(a.id) + '"' + sel + '>' + escText(a.label) + '</option>';
        });
        return html;
      }

      function typeOptionsHtml(selectedType) {
        var types = ['business_hours', 'play', 'gather', 'ring', 'wait', 'voicemail'];
        var html = '';
        types.forEach(function (t) {
          html += '<option value="' + t + '"' + (t === selectedType ? ' selected' : '') + '>' + t + '</option>';
        });
        return html;
      }

      function gatherOptionRowHtml(opt) {
        var digit = opt && opt.digit ? opt.digit : '';
        var next = opt && opt.nextNodeId ? opt.nextNodeId : '';
        return '<div class="gather-option-row">' +
          '<input type="text" class="opt-digit" placeholder="digit" value="' + escAttr(digit) + '">' +
          '<input type="text" class="opt-next" placeholder="nextNodeId" value="' + escAttr(next) + '">' +
          '<button type="button" class="remove-option-btn">Remove option</button>' +
          '</div>';
      }

      // Same field-group markup as the old flat-card editor, minus the entry-radio/remove-node
      // controls (Phase 1 has no canvas equivalent for those yet -- deferred to Phase 2).
      function buildFieldsHtml(node) {
        var config = node.config || {};
        var html = '';
        html += '<label>ID <input type="text" id="panel-id-input" value="' + escAttr(node.id) + '" readonly></label> ';
        html += '<label>Type <select id="panel-type-select" onchange="toggleFields(this)">' + typeOptionsHtml(node.type) + '</select></label>';

        html += '<div class="field-group" data-type="business_hours" style="display:' + (node.type === 'business_hours' ? 'block' : 'none') + '">' +
          '<label>Open next node <input type="text" class="f-openNextNodeId" value="' + escAttr(config.openNextNodeId) + '"></label> ' +
          '<label>Closed next node <input type="text" class="f-closedNextNodeId" value="' + escAttr(config.closedNextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="play" style="display:' + (node.type === 'play' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Next node <input type="text" class="f-nextNodeId" value="' + escAttr(config.nextNodeId) + '"></label>' +
          '</div>';

        var options = Array.isArray(config.options) ? config.options : [];
        var optionRows = options.map(gatherOptionRowHtml).join('');
        html += '<div class="field-group" data-type="gather" style="display:' + (node.type === 'gather' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label>' +
          '<div class="gather-options-list">' + optionRows + '</div>' +
          '<button type="button" class="add-option-btn">Add option</button> ' +
          '<label>Default next node <input type="text" class="f-defaultNextNodeId" value="' + escAttr(config.defaultNextNodeId) + '"></label> ' +
          '<label>Retry limit <input type="number" class="f-retryLimit" value="' + escAttr(config.retryLimit != null ? config.retryLimit : 3) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="ring" style="display:' + (node.type === 'ring' ? 'block' : 'none') + '">' +
          '<label>Target <select class="f-target">' +
          '<option value="all"' + (config.target === 'all' ? ' selected' : '') + '>all</option>' +
          '<option value="on_call_only"' + (config.target === 'on_call_only' ? ' selected' : '') + '>on_call_only</option>' +
          '</select></label> ' +
          '<label>Strategy <select class="f-strategy">' +
          '<option value="cascade"' + (config.strategy === 'cascade' ? ' selected' : '') + '>cascade</option>' +
          '<option value="simultaneous"' + (config.strategy === 'simultaneous' ? ' selected' : '') + '>simultaneous</option>' +
          '</select></label> ' +
          '<label>Timeout seconds <input type="number" class="f-timeoutSeconds" value="' + escAttr(config.timeoutSeconds != null ? config.timeoutSeconds : 20) + '"></label> ' +
          '<label>No-answer next node <input type="text" class="f-noAnswerNextNodeId" value="' + escAttr(config.noAnswerNextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="wait" style="display:' + (node.type === 'wait' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Allow callback (*) <input type="checkbox" class="f-allowCallbackStar"' + (config.allowCallbackStar ? ' checked' : '') + '></label> ' +
          '<label>Next node <input type="text" class="f-nextNodeId" value="' + escAttr(config.nextNodeId) + '"></label>' +
          '</div>';

        html += '<div class="field-group" data-type="voicemail" style="display:' + (node.type === 'voicemail' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Mailbox label <input type="text" class="f-mailboxLabel" value="' + escAttr(config.mailboxLabel) + '"></label>' +
          '</div>';

        return html;
      }

      function toggleFields(selectEl) {
        var panel = document.getElementById('edit-panel-fields');
        var groups = panel.querySelectorAll('.field-group');
        groups.forEach(function (g) {
          g.style.display = g.getAttribute('data-type') === selectEl.value ? 'block' : 'none';
        });
      }

      function audioOrTtsConfig(group) {
        var audioId = group.querySelector('.f-audioAssetId').value;
        var tts = group.querySelector('.f-ttsText').value.trim();
        return {
          audioAssetId: audioId ? audioId : null,
          ttsText: !audioId && tts ? tts : null,
        };
      }

      // Reads the currently-open panel's form fields for whatever type is selected and
      // returns { type, config } for the node being edited (editingIvrId).
      function collectNodeFromPanel() {
        var panel = document.getElementById('edit-panel-fields');
        var type = document.getElementById('panel-type-select').value;
        var group = panel.querySelector('.field-group[data-type="' + type + '"]');
        var config = {};
        if (type === 'business_hours') {
          config.openNextNodeId = group.querySelector('.f-openNextNodeId').value.trim();
          config.closedNextNodeId = group.querySelector('.f-closedNextNodeId').value.trim();
        } else if (type === 'play') {
          var pc = audioOrTtsConfig(group);
          config.audioAssetId = pc.audioAssetId;
          config.ttsText = pc.ttsText;
          config.nextNodeId = group.querySelector('.f-nextNodeId').value.trim();
        } else if (type === 'wait') {
          var wc = audioOrTtsConfig(group);
          config.audioAssetId = wc.audioAssetId;
          config.ttsText = wc.ttsText;
          config.allowCallbackStar = group.querySelector('.f-allowCallbackStar').checked;
          config.nextNodeId = group.querySelector('.f-nextNodeId').value.trim();
        } else if (type === 'voicemail') {
          var vc = audioOrTtsConfig(group);
          config.audioAssetId = vc.audioAssetId;
          config.ttsText = vc.ttsText;
          config.mailboxLabel = group.querySelector('.f-mailboxLabel').value.trim();
        } else if (type === 'gather') {
          var gc = audioOrTtsConfig(group);
          config.audioAssetId = gc.audioAssetId;
          config.ttsText = gc.ttsText;
          var options = [];
          group.querySelectorAll('.gather-option-row').forEach(function (row) {
            var digit = row.querySelector('.opt-digit').value.trim();
            var next = row.querySelector('.opt-next').value.trim();
            if (digit !== '') options.push({ digit: digit, nextNodeId: next });
          });
          config.options = options;
          config.defaultNextNodeId = group.querySelector('.f-defaultNextNodeId').value.trim();
          config.retryLimit = Number(group.querySelector('.f-retryLimit').value) || 0;
        } else if (type === 'ring') {
          config.target = group.querySelector('.f-target').value;
          config.strategy = group.querySelector('.f-strategy').value;
          config.timeoutSeconds = Number(group.querySelector('.f-timeoutSeconds').value) || 0;
          config.noAnswerNextNodeId = group.querySelector('.f-noAnswerNextNodeId').value.trim();
        }
        return { type: type, config: config };
      }

      // Every node-id-shaped outgoing reference for a node, by type -- used for both drawing
      // canvas connections and for the auto-layout BFS. Mirrors referencesForNode() in
      // src/api/ivrFlow.ts (kept in sync by hand since this runs as inline browser JS with no
      // shared module to import from).
      function outgoingRefs(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return [c.openNextNodeId, c.closedNextNodeId].filter(Boolean);
        if (node.type === 'play' || node.type === 'wait') return [c.nextNodeId].filter(Boolean);
        if (node.type === 'ring') return [c.noAnswerNextNodeId].filter(Boolean);
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return o.nextNodeId; }).concat([c.defaultNextNodeId]).filter(Boolean);
        }
        return [];
      }

      // Ordered list of { target } per output slot, in the SAME order used when the node's
      // Drawflow output count was decided in outputsCountForType -- addConnection uses
      // 1-based "output_N" slot names that must line up with this order.
      function outputHandlesForType(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return [{ target: c.openNextNodeId }, { target: c.closedNextNodeId }];
        if (node.type === 'play' || node.type === 'wait') return [{ target: c.nextNodeId }];
        if (node.type === 'ring') return [{ target: c.noAnswerNextNodeId }];
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return { target: o.nextNodeId }; }).concat([{ target: c.defaultNextNodeId }]);
        }
        return [];
      }

      function outputsCountForType(node) {
        if (node.type === 'voicemail') return 0;
        if (node.type === 'business_hours') return 2;
        if (node.type === 'gather') {
          var opts = Array.isArray(node.config.options) ? node.config.options : [];
          return opts.length + 1;
        }
        return 1;
      }

      // Layered/rank auto-layout: BFS from the entry node, ranking each node by hop distance.
      // Each rank becomes a column; nodes within a rank are stacked in rows. Nodes unreachable
      // from the entry (shouldn't normally exist, given the save API's cross-reference
      // validation, but a node could still be legitimately un-pointed-to) get appended as
      // trailing ranks so nothing silently disappears from the canvas. This only computes an
      // INITIAL position for nodes with no stored positionX/positionY -- it is never itself
      // persisted; a node only gets a real stored position once it's actually dragged.
      function computeAutoLayout(nodes) {
        var byId = {};
        nodes.forEach(function (n) { byId[n.id] = n; });

        var rank = {};
        var queue = entryNodeId ? [entryNodeId] : [];
        if (entryNodeId) rank[entryNodeId] = 0;
        while (queue.length > 0) {
          var currentId = queue.shift();
          var current = byId[currentId];
          if (!current) continue;
          outgoingRefs(current).forEach(function (nextId) {
            if (!(nextId in rank) && byId[nextId]) {
              rank[nextId] = rank[currentId] + 1;
              queue.push(nextId);
            }
          });
        }

        var maxRank = 0;
        Object.keys(rank).forEach(function (id) { if (rank[id] > maxRank) maxRank = rank[id]; });
        nodes.forEach(function (n) {
          if (!(n.id in rank)) {
            maxRank += 1;
            rank[n.id] = maxRank;
          }
        });

        var countPerRank = {};
        var positions = {};
        var RANK_WIDTH = 280;
        var ROW_HEIGHT = 160;
        nodes.forEach(function (n) {
          var r = rank[n.id];
          var row = countPerRank[r] || 0;
          countPerRank[r] = row + 1;
          positions[n.id] = { x: r * RANK_WIDTH + 40, y: row * ROW_HEIGHT + 40 };
        });
        return positions;
      }

      function nodeHtml(node) {
        return '<div class="ivr-node"><div class="ivr-node-id">' + escText(node.id) + '</div><div class="ivr-node-type">' + escText(node.type) + '</div></div>';
      }

      // Rendered for a reference target that isn't one of this flow's own nodes -- e.g.
      // shared_voicemail, which is tagged flow='main' but referenced as the no-answer/default
      // target from after_hours nodes too. listNodesForFlow() (both the page route and
      // GET/PUT /api/ivr/flows/:flow) scopes strictly by the flow column, so currentNodes
      // never contains these. Rather than silently dropping the connection, draw a dashed,
      // non-editable stub node so the cross-flow reference is visible on the canvas.
      function externalNodeHtml(id) {
        return '<div class="ivr-node ivr-node-external"><div class="ivr-node-id">' + escText(id) + '</div><div class="ivr-node-type">shared (other flow)</div></div>';
      }

      function renderAudioAssetList() {
        var el = document.getElementById('audio-asset-list');
        el.innerHTML = audioAssets
          .map(function (a) {
            return '<div>' + escText(a.label) + ' (' + escText(a.id) + ')</div>';
          })
          .join('');
      }

      async function refreshAudioAssets() {
        var res = await fetch('/api/ivr/audio');
        if (!res.ok) return;
        audioAssets = await res.json();
        document.querySelectorAll('.f-audioAssetId').forEach(function (sel) {
          var current = sel.value;
          sel.innerHTML = audioOptionsHtml(current);
          sel.value = current;
        });
        renderAudioAssetList();
      }

      function buildCanvas() {
        var container = document.getElementById('drawflow');
        editor = new Drawflow(container);
        editor.reroute = true;
        editor.start();

        var autoPositions = computeAutoLayout(currentNodes);
        var maxNodeX = 0;

        currentNodes.forEach(function (node) {
          var pos = (node.positionX != null && node.positionY != null)
            ? { x: node.positionX, y: node.positionY }
            : autoPositions[node.id];
          maxNodeX = Math.max(maxNodeX, pos.x);
          var numOutputs = outputsCountForType(node);
          var drawflowId = editor.addNode(node.type, 1, numOutputs, pos.x, pos.y, 'ivr-node', { ivrNodeId: node.id }, nodeHtml(node));
          drawflowIdToIvrId[drawflowId] = node.id;
          ivrIdToDrawflowId[node.id] = drawflowId;
        });

        // Cross-flow reference targets (see externalNodeHtml above) get a dashed stub node of
        // their own, stacked in a column to the right of every real node this flow has.
        var externalTargetIds = [];
        currentNodes.forEach(function (node) {
          outputHandlesForType(node).forEach(function (h) {
            if (h.target && !(h.target in ivrIdToDrawflowId) && externalTargetIds.indexOf(h.target) === -1) {
              externalTargetIds.push(h.target);
            }
          });
        });
        externalTargetIds.forEach(function (targetId, idx) {
          var stubX = maxNodeX + 280;
          var stubY = idx * 160 + 40;
          var stubDrawflowId = editor.addNode(targetId, 1, 0, stubX, stubY, 'ivr-node-external', { ivrNodeId: targetId }, externalNodeHtml(targetId));
          drawflowIdToIvrId[stubDrawflowId] = targetId;
          ivrIdToDrawflowId[targetId] = stubDrawflowId;
        });

        currentNodes.forEach(function (node) {
          var fromDrawflowId = ivrIdToDrawflowId[node.id];
          var handles = outputHandlesForType(node);
          handles.forEach(function (h, idx) {
            if (!h.target) return;
            var toDrawflowId = ivrIdToDrawflowId[h.target];
            if (toDrawflowId == null) return;
            editor.addConnection(fromDrawflowId, toDrawflowId, 'output_' + (idx + 1), 'input_1');
          });
        });

        editor.on('nodeMoved', function (drawflowId) {
          var ivrId = drawflowIdToIvrId[drawflowId];
          var node = currentNodes.filter(function (n) { return n.id === ivrId; })[0];
          // Stub nodes for cross-flow references (see externalNodeHtml) aren't part of this
          // flow -- dragging one is harmless in the UI but there is no position to persist,
          // and PATCHing this flow's endpoint for a node id that belongs to another flow would
          // just 404.
          if (!node) return;
          var data = editor.drawflow.drawflow[editor.module].data[drawflowId];
          var posX = Math.round(data.pos_x);
          var posY = Math.round(data.pos_y);
          node.positionX = posX;
          node.positionY = posY;
          fetch('/api/ivr/flows/' + encodeURIComponent(FLOW) + '/nodes/' + encodeURIComponent(ivrId) + '/position', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionX: posX, positionY: posY }),
          });
        });

        editor.on('nodeSelected', function (drawflowId) {
          var ivrId = drawflowIdToIvrId[drawflowId];
          openEditPanel(ivrId);
        });
      }

      function openEditPanel(ivrId) {
        var node = currentNodes.filter(function (n) { return n.id === ivrId; })[0];
        if (!node) return;
        editingIvrId = ivrId;
        document.getElementById('save-status').textContent = '';
        document.getElementById('edit-panel-fields').innerHTML = buildFieldsHtml(node);
        document.getElementById('edit-panel').classList.add('open');
      }

      document.getElementById('close-panel-btn').addEventListener('click', function () {
        document.getElementById('edit-panel').classList.remove('open');
        editingIvrId = null;
      });

      document.getElementById('save-node-btn').addEventListener('click', async function () {
        if (!editingIvrId) return;
        var updated = collectNodeFromPanel();
        var node = currentNodes.filter(function (n) { return n.id === editingIvrId; })[0];
        node.type = updated.type;
        node.config = updated.config;

        var status = document.getElementById('save-status');
        var payload = {
          entryNodeId: entryNodeId,
          nodes: currentNodes.map(function (n) {
            return { id: n.id, type: n.type, config: n.config, positionX: n.positionX, positionY: n.positionY };
          }),
        };
        var res = await fetch('/api/ivr/flows/' + encodeURIComponent(FLOW), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          status.textContent = 'Saved.';
          document.getElementById('edit-panel').classList.remove('open');
          editingIvrId = null;
        } else {
          var text = await res.text();
          status.textContent = 'Failed to save: ' + text;
        }
      });

      document.getElementById('edit-panel-fields').addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('add-option-btn')) {
          var group = t.closest('.field-group');
          var list = group.querySelector('.gather-options-list');
          var div = document.createElement('div');
          div.innerHTML = gatherOptionRowHtml(null);
          list.appendChild(div.firstChild);
        } else if (t.classList.contains('remove-option-btn')) {
          t.closest('.gather-option-row').remove();
        }
      });

      document.getElementById('audio-upload-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        var status = document.getElementById('audio-upload-status');
        var fileInput = document.getElementById('audio-file-input');
        var labelInput = document.getElementById('audio-label-input');
        var formData = new FormData();
        if (fileInput.files.length > 0) formData.append('file', fileInput.files[0]);
        if (labelInput.value) formData.append('label', labelInput.value);
        var res = await fetch('/api/ivr/audio', { method: 'POST', body: formData });
        if (res.ok) {
          status.textContent = 'Uploaded.';
          fileInput.value = '';
          labelInput.value = '';
          await refreshAudioAssets();
        } else {
          status.textContent = 'Upload failed.';
        }
      });

      if (window.Drawflow) {
        buildCanvas();
      } else {
        document.getElementById('cdn-error').style.display = 'block';
      }
      renderAudioAssetList();
    </script>`;

  return renderLayout(`IVR Flow: ${flow}`, "ivr", body, { extraHead: extraHead, fullWidth: true });
}
