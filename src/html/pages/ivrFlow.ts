import { escapeHtml, renderLayout } from "../layout";
import type { IvrNode } from "../../db/ivrNodes";

// Embeds a value as a JSON literal inside a <script> block. Guards against a stray
// "</script>" inside e.g. an uploaded audio-asset label or a node's ttsText breaking out
// of the script tag early.
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderIvrFlowPage(
  flow: string,
  nodes: IvrNode[],
  audioAssets: { id: string; label: string }[]
): string {
  const body = `<h2>IVR Flow: ${escapeHtml(flow)}</h2>
    <p>Entry node is marked with the radio button. "Save Flow" replaces every node in this flow.</p>
    <div id="node-cards"></div>
    <p>
      <button type="button" id="add-node-btn">Add node</button>
      <button type="button" id="save-flow-btn">Save Flow</button>
      <span id="save-status"></span>
    </p>

    <h3>Upload audio</h3>
    <form id="audio-upload-form">
      <input type="file" id="audio-file-input" name="file" required>
      <input type="text" id="audio-label-input" name="label" placeholder="Label">
      <button type="submit">Upload</button>
      <span id="audio-upload-status"></span>
    </form>
    <div id="audio-asset-list"></div>

    <script>
      var FLOW = ${safeJsonForScript(flow)};
      var initialNodes = ${safeJsonForScript(nodes)};
      var audioAssets = ${safeJsonForScript(audioAssets)};
      var nodeCount = 0;

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

      function buildCardHtml(idx, node) {
        var config = node.config || {};
        var isEntry = !!node.isEntry;
        var html = '';
        html += '<div class="node-card" data-idx="' + idx + '" style="border:1px solid #ccc;padding:0.75rem;margin-bottom:0.75rem;">';
        html += '<label>Entry node <input type="radio" name="entryNodeId" data-idx="' + idx + '"' + (isEntry ? ' checked' : '') + '></label> ';
        html += '<label>ID <input type="text" class="node-id-input" value="' + escAttr(node.id) + '"></label> ';
        html += '<label>Type <select class="node-type-select" onchange="toggleFields(this)">' + typeOptionsHtml(node.type) + '</select></label>';

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

        html += ' <button type="button" class="remove-node-btn">Remove node</button>';
        html += '</div>';
        return html;
      }

      function toggleFields(selectEl) {
        var card = selectEl.closest('.node-card');
        var groups = card.querySelectorAll('.field-group');
        groups.forEach(function (g) {
          g.style.display = g.getAttribute('data-type') === selectEl.value ? 'block' : 'none';
        });
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

      function initCards() {
        var container = document.getElementById('node-cards');
        var html = '';
        initialNodes.forEach(function (node, i) {
          html += buildCardHtml(i, node);
        });
        container.innerHTML = html;
        nodeCount = initialNodes.length;
      }

      document.getElementById('node-cards').addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('add-option-btn')) {
          var group = t.closest('.field-group');
          var list = group.querySelector('.gather-options-list');
          var div = document.createElement('div');
          div.innerHTML = gatherOptionRowHtml(null);
          list.appendChild(div.firstChild);
        } else if (t.classList.contains('remove-option-btn')) {
          t.closest('.gather-option-row').remove();
        } else if (t.classList.contains('remove-node-btn')) {
          t.closest('.node-card').remove();
        }
      });

      document.getElementById('add-node-btn').addEventListener('click', function () {
        var idx = 'new-' + nodeCount;
        nodeCount += 1;
        var newNode = {
          id: 'node-' + Date.now(),
          type: 'play',
          isEntry: false,
          config: { audioAssetId: null, ttsText: '', nextNodeId: '' },
        };
        var div = document.createElement('div');
        div.innerHTML = buildCardHtml(idx, newNode);
        document.getElementById('node-cards').appendChild(div.firstChild);
      });

      // Whichever of audioAssetId/ttsText the staff member filled in is sent as the real
      // value and the other is nulled out -- they don't have to manually blank one.
      function audioOrTtsConfig(group) {
        var audioId = group.querySelector('.f-audioAssetId').value;
        var tts = group.querySelector('.f-ttsText').value.trim();
        return {
          audioAssetId: audioId ? audioId : null,
          ttsText: !audioId && tts ? tts : null,
        };
      }

      function collectNodes() {
        var cards = document.querySelectorAll('.node-card');
        var nodes = [];
        var checkedRadio = document.querySelector('input[name="entryNodeId"]:checked');
        var entryNodeId = null;
        cards.forEach(function (card) {
          var id = card.querySelector('.node-id-input').value.trim();
          var type = card.querySelector('.node-type-select').value;
          var group = card.querySelector('.field-group[data-type="' + type + '"]');
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
          nodes.push({ id: id, type: type, config: config });
          if (checkedRadio && checkedRadio.getAttribute('data-idx') === card.getAttribute('data-idx')) {
            entryNodeId = id;
          }
        });
        return { entryNodeId: entryNodeId, nodes: nodes };
      }

      document.getElementById('save-flow-btn').addEventListener('click', async function () {
        var status = document.getElementById('save-status');
        var payload = collectNodes();
        var res = await fetch('/api/ivr/flows/' + encodeURIComponent(FLOW), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          status.textContent = 'Saved.';
        } else {
          var text = await res.text();
          status.textContent = 'Failed to save: ' + text;
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

      initCards();
      renderAudioAssetList();
    </script>`;
  return renderLayout(`IVR Flow: ${flow}`, "ivr", body);
}
