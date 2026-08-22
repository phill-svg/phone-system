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
  audioAssets: { id: string; label: string }[],
  staffEmails: string[]
): string {
  const extraHead = `<link rel="stylesheet" href="${DRAWFLOW_CSS_URL}">
    <style>
      #canvas-wrap { position: relative; height: calc(100vh - 64px); }
      #ivr-toolbar { position: absolute; top: 12px; left: 12px; z-index: 15; display: flex; gap: 10px; align-items: center; }
      #add-node-btn {
        background: #1a3d2e; color: white;
        border: none; border-radius: 8px; padding: 0.55rem 1rem; font-size: 0.9rem; font-weight: 600;
        cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.15);
      }
      #ivr-zoom { display: flex; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
      #ivr-zoom button { background: #fff; border: none; border-left: 1px solid #eef0f3; color: #374151; font-size: 0.9rem; font-weight: 600; padding: 0.5rem 0.75rem; cursor: pointer; min-width: 40px; }
      #ivr-zoom button:first-child { border-left: none; }
      #ivr-zoom button:hover { background: #f3f4f6; }
      #drawflow { width: 100%; height: 100%; background: #f8f9fa; background-image: radial-gradient(#e2e5ea 1px, transparent 1px); background-size: 16px 16px; }
      #cdn-error { display: none; padding: 1rem; background: #fde8e8; color: #9b1c1c; }
      /* Drawflow's own CSS lays a node out as a flex ROW (input on the left edge, content in the
         middle, output on the right edge, all vertically centered) at a hardcoded 160px width --
         built for left-to-right flow diagrams. Our canvas is a top-down TREE (see
         computeAutoLayout below), so that default geometry is exactly backwards for us: it anchors
         every connector to the left/right edges of an invisible 160px box that doesn't even match
         our actual card width, which is what produced the loose diagonal, criss-crossing connector
         lines the Aircall reference doesn't have. Overriding to a block box sized to the real
         rendered content, with inputs/outputs re-anchored to the top/bottom edge (in branch order,
         left to right), makes each connector run from the true bottom-center of a parent card to
         the true top-center of a child card -- vertical rank-to-rank, matching the reference.
         (Confirmed by inspecting live getBoundingClientRect() values in a running instance of this
         page before writing this override -- the un-overridden ports sat ~30-40px off the visible
         card's actual edges.) */
      .drawflow .drawflow-node { display: block; width: max-content; }
      .drawflow .drawflow-node .drawflow_content_node { width: auto; display: block; }
      .drawflow .drawflow-node { background: transparent; box-shadow: none; padding: 0; min-width: 0; border: none; }
      .drawflow .drawflow-node.selected { background: transparent; box-shadow: none; border: none; }
      .drawflow .drawflow-node.selected .ivr-node-card { box-shadow: 0 0 0 2px #1a3d2e, 0 1px 3px rgba(0,0,0,0.1); }
      .drawflow .drawflow-node .inputs, .drawflow .drawflow-node .outputs {
        position: absolute; left: 0; width: 100%; height: 0; display: flex; justify-content: center; align-items: center; gap: 14px;
      }
      .drawflow .drawflow-node .inputs { top: -5px; }
      .drawflow .drawflow-node .outputs { bottom: -5px; }
      .drawflow .drawflow-node .input, .drawflow .drawflow-node .output {
        position: relative; left: auto; right: auto; top: auto; margin: 0;
        width: 9px; height: 9px; background: #fff; border: 2px solid #9aa4b2; opacity: 1; border-radius: 50%;
      }
      /* Drawflow renders one .output marker PER OUTPUT PORT along a node's bottom edge (e.g. 5
         for the 5-branch Menu gather), spaced a few px apart. applyOrthogonalConnections (see
         script below) already collapses those branches' rendered LINES onto one shared trunk-x,
         but it can't move these separate static markers -- left visible, they'd sit as a stray
         row of unconnected-looking dots along the bottom edge, exactly the "spider" look the
         single-trunk fix is meant to remove. Hiding them is safe: the trunk's own junction dot
         (an <circle class="ivr-bend-dot"> the script adds at the actual bend, not at the card
         edge) is what carries that marker in the reference instead. .input stays visible --
         the reference does show a dot at each card's top/entry point. */
      .drawflow .drawflow-node .output { opacity: 0; }
      /* Aircall's real flow editor draws crisp, mostly-orthogonal (right-angle) connector lines
         with small hollow "junction dot" markers at bend points, in a thin light gray -- nothing
         like Drawflow's default thick blue Bezier curves. We don't fork Drawflow to draw real
         right-angle paths; applyOrthogonalConnections() (see script below) rewrites each
         connection's rendered path's "d" attribute after the fact, and appends <circle class="ivr-bend-dot">
         markers into the same per-connection <svg> at the bends. This CSS just re-skins the
         (now-orthogonal) path and those dots to match the reference's line weight/color. */
      .drawflow .connection .main-path { stroke: #c7ccd6; stroke-width: 1.5px; }
      .drawflow .connection .ivr-bend-dot { fill: #ffffff; stroke: #b7bfca; stroke-width: 1.3px; }
      .ivr-branch-label { display: inline-block; background: #eef1f5; color: #4b5563; font-size: 0.68rem; font-weight: 600; padding: 0.15rem 0.55rem; border-radius: 999px; margin-bottom: 0.35rem; white-space: nowrap; }
      .ivr-node-card { display: flex; align-items: flex-start; gap: 0.6rem; background: white; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 0.6rem 0.75rem; width: 210px; cursor: pointer; }
      .ivr-node-card-external { border-style: dashed; opacity: 0.7; cursor: default; }
      .ivr-node-icon { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.9rem; }
      .ivr-node-body { min-width: 0; }
      .ivr-node-title { font-weight: 600; font-size: 0.85rem; color: #111827; }
      .ivr-node-subtitle { font-size: 0.72rem; color: #6b7280; margin-top: 0.15rem; word-break: break-word; }
      .ivr-node-card-warn { border-color: #f0b429; box-shadow: 0 0 0 1px #f0b429, 0 1px 3px rgba(0,0,0,0.1); }
      .ivr-node-warn { font-size: 0.68rem; color: #b45309; margin-top: 0.25rem; font-weight: 600; }
      .ivr-node-idsmall { font-size: 0.62rem; color: #b0b5bd; margin-top: 0.25rem; }
      .ivr-pill { display: inline-flex; align-items: center; gap: 0.35rem; background: #12283f; color: white; border-radius: 999px; padding: 0.4rem 0.9rem; font-size: 0.78rem; font-weight: 500; cursor: default; white-space: nowrap; }
      #edit-panel { display: none; position: fixed; top: 0; right: 0; width: 380px; height: 100vh; background: white; border-left: 1px solid #e5e7eb; padding: 1.25rem; overflow-y: auto; box-shadow: -4px 0 16px rgba(0,0,0,0.08); z-index: 10; }
      #edit-panel.open { display: block; }
      #close-panel-btn { float: right; border: none; background: none; font-size: 1.1rem; color: #9ca3af; cursor: pointer; }
      #edit-panel-fields { clear: both; padding-top: 0.5rem; }
      #edit-panel-fields label { display: block; font-size: 0.75rem; font-weight: 600; color: #4b5563; margin-top: 0.9rem; margin-bottom: 0.3rem; }
      #edit-panel-fields label:first-of-type { margin-top: 0; }
      #edit-panel-fields input[type=text], #edit-panel-fields input[type=number], #edit-panel-fields select {
        display: block; width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem; font-size: 0.85rem;
        border: 1px solid #d1d5db; border-radius: 6px; background: white; color: #111827; margin-top: 0.15rem;
      }
      #edit-panel-fields select option { color: #111827; background: #ffffff; }
      #edit-panel-fields input[readonly] { background: #f3f4f6; color: #6b7280; }
      #edit-panel-fields input[type=checkbox] { width: 34px; height: 18px; vertical-align: middle; accent-color: #1a3d2e; }
      #edit-panel-fields .gather-option-row { display: flex; gap: 0.4rem; align-items: center; margin-bottom: 0.4rem; }
      #edit-panel-fields .gather-option-row input { margin: 0; }
      #edit-panel-fields .gather-option-row .opt-digit { width: 60px; flex-shrink: 0; }
      #edit-panel-fields button, #save-node-btn {
        background: #1a3d2e; color: white; border: none; border-radius: 6px; padding: 0.45rem 0.9rem;
        font-size: 0.8rem; cursor: pointer; margin-top: 0.4rem;
      }
      #edit-panel-fields .remove-option-btn { background: #9ca3af; }
      #save-node-btn { margin-top: 1.25rem; }
      #delete-node-btn { margin-top: 1.25rem; margin-left: 0.5rem; background: #b91c1c; }
      /* Custom node-type picker for the edit panel's "Type" field, replacing a native <select> --
         matches the Aircall reference's popup list of icon-badge + label rows (native <option>
         elements can't render the icon badges). A hidden native <select id="panel-type-select">
         stays in the DOM as the actual source of truth (collectNodeFromPanel/toggleFields keep
         reading/writing it unchanged) -- this is a presentation-layer swap only. */
      .ivr-type-picker { position: relative; margin-top: 0.15rem; }
      /* Specificity note: #edit-panel-fields already has a "#edit-panel-fields button" rule
         (dark-green background/white text, for Save/Add-option/Remove-option) that would
         otherwise beat a plain ".ivr-type-picker-btn" class selector and paint this button the
         same dark green -- matching that id+element specificity here to win instead. */
      #edit-panel-fields .ivr-type-picker-btn {
        display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
        padding: 0.45rem 0.6rem; font-size: 0.85rem; border: 1px solid #d1d5db; border-radius: 6px;
        background: white; color: #111827; cursor: pointer; text-align: left; font-family: inherit; margin-top: 0;
      }
      .ivr-type-picker-caret { margin-left: auto; color: #9ca3af; font-size: 0.7rem; }
      .ivr-type-picker-list {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: white;
        border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        z-index: 20; max-height: 260px; overflow-y: auto;
      }
      .ivr-type-picker-row { display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0.65rem; font-size: 0.85rem; cursor: pointer; }
      .ivr-type-picker-row:hover { background: #f3f4f6; }
      .ivr-type-picker-row.selected { background: #eef1f5; font-weight: 600; }
      .ivr-type-picker-icon { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.75rem; }
    </style>`;

  const body = `<div id="cdn-error">Could not load the flow editor library. Check your connection and reload the page.</div>
    <div id="canvas-wrap">
      <div id="ivr-toolbar">
        <button type="button" id="add-node-btn">+ Add step</button>
        <div id="ivr-zoom">
          <button type="button" id="zoom-out" title="Zoom out">&minus;</button>
          <button type="button" id="zoom-fit" title="Fit flow to screen">Fit</button>
          <button type="button" id="zoom-in" title="Zoom in">+</button>
        </div>
      </div>
      <div id="drawflow"></div>
    </div>
    <div id="edit-panel">
      <button type="button" id="close-panel-btn">Close</button>
      <div id="edit-panel-fields"></div>
      <p><button type="button" id="save-node-btn">Save node</button> <button type="button" id="delete-node-btn">Delete node</button> <span id="save-status"></span></p>
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
      var staffEmails = ${safeJsonForScript(staffEmails)};
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
        var types = ['date_rule', 'business_hours', 'play', 'gather', 'input', 'wait', 'ring', 'redirect', 'voicemail'];
        var html = '';
        types.forEach(function (t) {
          var label = NODE_META[t] ? NODE_META[t].label : t;
          html += '<option value="' + t + '"' + (t === selectedType ? ' selected' : '') + '>' + label + '</option>';
        });
        return html;
      }

      // Icon-badge + label content for the type picker's closed-state button -- reuses the same
      // NODE_META already used for the node cards, so the picker's icons match the canvas.
      function typePickerBtnHtml(selectedType) {
        var meta = NODE_META[selectedType] || { icon: '●', color: '#6b7280', label: selectedType };
        return '<span class="ivr-type-picker-icon" style="background:' + meta.color + '">' + meta.icon + '</span>' +
          '<span>' + escText(meta.label) + '</span><span class="ivr-type-picker-caret">▾</span>';
      }

      // One row per node type for the type picker's open popup list.
      function typePickerRowsHtml(selectedType) {
        var types = ['date_rule', 'business_hours', 'play', 'gather', 'input', 'wait', 'ring', 'redirect', 'voicemail'];
        return types.map(function (t) {
          var meta = NODE_META[t];
          return '<div class="ivr-type-picker-row' + (t === selectedType ? ' selected' : '') + '" data-type="' + t + '">' +
            '<span class="ivr-type-picker-icon" style="background:' + meta.color + '">' + meta.icon + '</span>' +
            '<span>' + escText(meta.label) + '</span></div>';
        }).join('');
      }

      function gatherOptionRowHtml(opt) {
        var digit = opt && opt.digit ? opt.digit : '';
        var next = opt && opt.nextNodeId ? opt.nextNodeId : '';
        return '<div class="gather-option-row">' +
          '<input type="text" class="opt-digit" placeholder="digit" value="' + escAttr(digit) + '">' +
          nodeSelect('opt-next', next) +
          '<button type="button" class="remove-option-btn">Remove option</button>' +
          '</div>';
      }

      // Same field-group markup as the old flat-card editor, minus the remove-node control
      // (Phase 1 has no canvas equivalent for that yet -- deferred to Phase 2). The entry
      // checkbox below WAS on that deferred list too, but turned out load-bearing for the
      // "+ Add node" feature: every non-voicemail node type requires a non-empty forward
      // reference (see isPlayConfig/isGatherConfig/etc. in src/api/ivrFlow.ts), so building a
      // flow up from zero nodes forces the very first addable node to be a bare voicemail (the
      // only type with referencesForNode() === []) -- which then auto-becomes the entry (see
      // openAddPanel/save-node-btn below), permanently stuck there with no way to move it to the
      // greeting/menu node that should actually be the entry. This checkbox is the escape hatch:
      // check it on any OTHER node to transfer entryNodeId to that node on the next save.
      // A "where does this go next" dropdown of every step in this flow (plus "End call") --
      // replaces typing a raw node id, which was the single biggest bit of editor friction.
      // Preserves a value that points at a node in another flow so editing doesn't drop it.
      function nodeSelect(cls, currentValue) {
        var cur = currentValue == null ? '' : String(currentValue);
        var known = {};
        var opts = '<option value=""' + (cur === '' ? ' selected' : '') + '>— End call —</option>';
        currentNodes.forEach(function (n) {
          known[n.id] = true;
          var meta = NODE_META[n.type] || { label: n.type };
          opts += '<option value="' + escAttr(n.id) + '"' + (cur === String(n.id) ? ' selected' : '') + '>' +
            escText(meta.label + ' · ' + truncate(subtitleForNode(n) || ('#' + n.id), 24)) + '</option>';
        });
        if (cur && !known[cur]) {
          opts += '<option value="' + escAttr(cur) + '" selected>' + escText(cur + ' (other flow)') + '</option>';
        }
        opts += '<option value="__new__">➕ Add a new step here…</option>';
        return '<select class="' + cls + ' ivr-next-select">' + opts + '</select>';
      }

      function buildFieldsHtml(node, isNew) {
        var config = node.config || {};
        var html = '';
        html += '<label>ID <input type="text" id="panel-id-input" value="' + escAttr(node.id) + '"' + (isNew ? '' : ' readonly') + '></label> ';
        // The entry point is defined by what's wired to "Call comes in" on the canvas, so no entry
        // checkbox in the panel. The first node added to an empty flow still auto-becomes the entry
        // (see the save handler); a hidden checkbox keeps that handler's checked lookup happy.
        var forcedFirstEntry = isNew && entryNodeId === null;
        html += '<input type="checkbox" id="panel-entry-checkbox" style="display:none"' + (forcedFirstEntry ? ' checked' : '') + '>';
        html += '<label>Type</label>' +
          '<div class="ivr-type-picker" id="panel-type-picker">' +
          '<button type="button" class="ivr-type-picker-btn" id="panel-type-picker-btn">' + typePickerBtnHtml(node.type) + '</button>' +
          '<div class="ivr-type-picker-list" id="panel-type-picker-list" style="display:none">' + typePickerRowsHtml(node.type) + '</div>' +
          '</div>' +
          '<select id="panel-type-select" style="display:none">' + typeOptionsHtml(node.type) + '</select>';

        html += '<div class="field-group" data-type="business_hours" style="display:' + (node.type === 'business_hours' ? 'block' : 'none') + '">' +
          '<label>When open, go to</label>' + nodeSelect('f-openNextNodeId', config.openNextNodeId) +
          '<label>When closed, go to</label>' + nodeSelect('f-closedNextNodeId', config.closedNextNodeId) +
          '</div>';

        html += '<div class="field-group" data-type="play" style="display:' + (node.type === 'play' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Then go to</label>' + nodeSelect('f-nextNodeId', config.nextNodeId) +
          '</div>';

        var options = Array.isArray(config.options) ? config.options : [];
        var optionRows = options.map(gatherOptionRowHtml).join('');
        html += '<div class="field-group" data-type="gather" style="display:' + (node.type === 'gather' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label>' +
          '<div class="gather-options-list">' + optionRows + '</div>' +
          '<button type="button" class="add-option-btn">Add option</button> ' +
          '<label>If no or wrong input, go to</label>' + nodeSelect('f-defaultNextNodeId', config.defaultNextNodeId) + ' ' +
          '<label>Retry limit <input type="number" class="f-retryLimit" value="' + escAttr(config.retryLimit != null ? config.retryLimit : 3) + '"></label>' +
          '</div>';

        var targetIsAll = config.target === 'all';
        var targetList = Array.isArray(config.target) ? config.target : [];
        var staffCheckboxesHtml = staffEmails.map(function (email) {
          var checked = targetList.indexOf(email) !== -1 ? ' checked' : '';
          return '<label style="font-weight:400;"><input type="checkbox" class="f-target-email" value="' + escAttr(email) + '"' + checked + '> ' + escText(email) + '</label>';
        }).join('');
        html += '<div class="field-group" data-type="ring" style="display:' + (node.type === 'ring' ? 'block' : 'none') + '">' +
          '<label><input type="checkbox" class="f-target-all" onchange="toggleRingTargetList(this)"' + (targetIsAll ? ' checked' : '') + '> All available staff</label>' +
          '<div class="f-target-list" style="display:' + (targetIsAll ? 'none' : 'block') + '">' + staffCheckboxesHtml + '</div>' +
          '<label>Strategy <select class="f-strategy">' +
          '<option value="cascade"' + (config.strategy === 'cascade' ? ' selected' : '') + '>cascade</option>' +
          '<option value="simultaneous"' + (config.strategy === 'simultaneous' ? ' selected' : '') + '>simultaneous</option>' +
          '</select></label> ' +
          '<label>Timeout seconds <input type="number" class="f-timeoutSeconds" value="' + escAttr(config.timeoutSeconds != null ? config.timeoutSeconds : 20) + '"></label> ' +
          '<label>If nobody answers, go to</label>' + nodeSelect('f-noAnswerNextNodeId', config.noAnswerNextNodeId) +
          '</div>';

        html += '<div class="field-group" data-type="wait" style="display:' + (node.type === 'wait' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Allow callback (*) <input type="checkbox" class="f-allowCallbackStar"' + (config.allowCallbackStar ? ' checked' : '') + '></label> ' +
          '<label>Then go to</label>' + nodeSelect('f-nextNodeId', config.nextNodeId) +
          '</div>';

        html += '<div class="field-group" data-type="voicemail" style="display:' + (node.type === 'voicemail' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Mailbox label <input type="text" class="f-mailboxLabel" value="' + escAttr(config.mailboxLabel) + '"></label>' +
          '</div>';

        var closedDates = Array.isArray(config.closedDates) ? config.closedDates.join(', ') : '';
        html += '<div class="field-group" data-type="date_rule" style="display:' + (node.type === 'date_rule' ? 'block' : 'none') + '">' +
          '<label>Closed dates <input type="text" class="f-closedDates" value="' + escAttr(closedDates) + '" placeholder="2026-12-25, 12-26, 2026-12-24..2027-01-02"></label>' +
          '<div style="font-size:0.72rem;color:#6b7280;margin:-0.3rem 0 0.4rem">Comma-separated. Use YYYY-MM-DD, MM-DD (every year), or start..end ranges.</div>' +
          '<label>When open, go to</label>' + nodeSelect('f-openNextNodeId', config.openNextNodeId) +
          '<label>When closed, go to</label>' + nodeSelect('f-closedNextNodeId', config.closedNextNodeId) +
          '</div>';

        html += '<div class="field-group" data-type="input" style="display:' + (node.type === 'input' ? 'block' : 'none') + '">' +
          '<label>Audio asset <select class="f-audioAssetId">' + audioOptionsHtml(config.audioAssetId) + '</select></label> ' +
          '<label>TTS text <input type="text" class="f-ttsText" value="' + escAttr(config.ttsText) + '"></label> ' +
          '<label>Max digits <input type="number" class="f-numDigits" value="' + escAttr(config.numDigits != null ? config.numDigits : 6) + '"></label> ' +
          '<label>Then go to</label>' + nodeSelect('f-nextNodeId', config.nextNodeId) +
          '</div>';

        html += '<div class="field-group" data-type="redirect" style="display:' + (node.type === 'redirect' ? 'block' : 'none') + '">' +
          '<label>Forward to number <input type="text" class="f-number" value="' + escAttr(config.number) + '" placeholder="+61 2 xxxx xxxx"></label>' +
          '</div>';

        return html;
      }

      function toggleRingTargetList(checkboxEl) {
        var group = checkboxEl.closest('.field-group');
        var list = group.querySelector('.f-target-list');
        list.style.display = checkboxEl.checked ? 'none' : 'block';
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
          var allChecked = group.querySelector('.f-target-all').checked;
          if (allChecked) {
            config.target = 'all';
          } else {
            var checkedEmails = [];
            group.querySelectorAll('.f-target-email:checked').forEach(function (cb) { checkedEmails.push(cb.value); });
            config.target = checkedEmails;
          }
          config.strategy = group.querySelector('.f-strategy').value;
          config.timeoutSeconds = Number(group.querySelector('.f-timeoutSeconds').value) || 0;
          config.noAnswerNextNodeId = group.querySelector('.f-noAnswerNextNodeId').value.trim();
        } else if (type === 'date_rule') {
          config.closedDates = group.querySelector('.f-closedDates').value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
          config.openNextNodeId = group.querySelector('.f-openNextNodeId').value.trim();
          config.closedNextNodeId = group.querySelector('.f-closedNextNodeId').value.trim();
        } else if (type === 'input') {
          var ic = audioOrTtsConfig(group);
          config.audioAssetId = ic.audioAssetId;
          config.ttsText = ic.ttsText;
          config.numDigits = Number(group.querySelector('.f-numDigits').value) || 6;
          config.nextNodeId = group.querySelector('.f-nextNodeId').value.trim();
        } else if (type === 'redirect') {
          config.number = group.querySelector('.f-number').value.trim();
        }
        return { type: type, config: config };
      }

      // Every node-id-shaped outgoing reference for a node, by type -- used for the auto-layout
      // BFS (synthetic pill targets deliberately excluded here so they don't affect ranking;
      // they're positioned relative to their one real parent instead, see buildCanvas). Mirrors
      // referencesForNode() in src/api/ivrFlow.ts (kept in sync by hand since this runs as inline
      // browser JS with no shared module to import from).
      function outgoingRefs(node) {
        var c = node.config || {};
        if (node.type === 'business_hours' || node.type === 'date_rule') return [c.openNextNodeId, c.closedNextNodeId].filter(Boolean);
        if (node.type === 'play' || node.type === 'wait' || node.type === 'input') return [c.nextNodeId].filter(Boolean);
        if (node.type === 'ring') return [c.noAnswerNextNodeId].filter(Boolean);
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return o.nextNodeId; }).concat([c.defaultNextNodeId]).filter(Boolean);
        }
        return [];
      }

      // Ordered list of { target, label } per output slot, in the SAME order used when the
      // node's Drawflow output count was decided in outputsCountForType -- addConnection uses
      // 1-based "output_N" slot names that must line up with this order. The "label" field is a
      // short branch badge shown above the target node's card (null when there's only one path, since
      // an unlabeled single connector reads fine on its own -- matches the Aircall reference,
      // which only labels branch points). ring's answered outcome and voicemail's terminal
      // outcome both route to the single synthetic "__pill_call_ends" target -- not a real
      // ivr_node, just a shared decorative end-of-call marker (one per canvas, not one per
      // branch -- see buildCanvas) created before this function's targets are resolved into
      // Drawflow connections. Matches the Aircall reference, which shows exactly one "Call ends"
      // pill that every branch converges into, rather than a separate end marker per branch.
      function outputHandlesForType(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return [{ target: c.openNextNodeId, label: 'Open' }, { target: c.closedNextNodeId, label: 'Closed' }];
        if (node.type === 'date_rule') return [{ target: c.openNextNodeId, label: 'Open' }, { target: c.closedNextNodeId, label: 'Closed' }];
        if (node.type === 'play' || node.type === 'wait' || node.type === 'input') return [{ target: c.nextNodeId, label: null }];
        if (node.type === 'ring') return [{ target: '__pill_call_ends', label: null }, { target: c.noAnswerNextNodeId, label: 'No answer' }];
        if (node.type === 'gather') {
          var opts = Array.isArray(c.options) ? c.options : [];
          return opts.map(function (o) { return { target: o.nextNodeId, label: 'Press ' + o.digit }; }).concat([{ target: c.defaultNextNodeId, label: 'No input' }]);
        }
        if (node.type === 'voicemail' || node.type === 'redirect') return [{ target: '__pill_call_ends', label: null }];
        return [];
      }

      function outputsCountForType(node) {
        if (node.type === 'voicemail' || node.type === 'redirect') return 1; // synthetic "Call ended" pill
        if (node.type === 'business_hours' || node.type === 'date_rule') return 2;
        if (node.type === 'gather') {
          var opts = Array.isArray(node.config.options) ? node.config.options : [];
          return opts.length + 1;
        }
        if (node.type === 'ring') return 2; // synthetic "Call answered" pill + real no-answer target
        return 1; // play, wait, input
      }

      var COLUMN_WIDTH = 300;
      var RANK_HEIGHT = 150;
      var TOP_MARGIN = RANK_HEIGHT; // headroom for the "Call comes in" pill above rank 0

      // Layered/rank auto-layout: BFS from the entry node, ranking each node by hop distance --
      // each rank is now a horizontal ROW (top-down tree, matching the Aircall reference) rather
      // than the previous left-to-right column layout; nodes within a rank spread across columns.
      // Nodes unreachable from the entry (shouldn't normally exist, given the save API's
      // cross-reference validation, but a node could still be legitimately un-pointed-to) get
      // appended as trailing ranks so nothing silently disappears from the canvas. This only
      // computes an INITIAL position for nodes with no stored positionX/positionY -- it is never
      // itself persisted; a node only gets a real stored position once it's actually dragged.
      //
      // Column order within a rank MUST come from BFS visitation order, not from the "nodes"
      // array's own order. "nodes" is whatever listNodesForFlow's unordered SELECT * ... WHERE
      // flow = ? happened to return (see src/db/ivrNodes.ts -- no ORDER BY, and a full
      // delete-then-reinsert on every save means that order can drift over time from whatever
      // order a past save's payload happened to list nodes in). Since each parent's children are
      // enqueued in outgoingRefs' order -- which mirrors outputHandlesForType's branch/option
      // order used for the connections and labels below -- a plain BFS queue already visits every
      // rank's nodes left-to-right in correct branch order *for free*; the bug was discarding that
      // order and re-deriving columns from the unrelated "nodes" array instead, which could easily
      // disagree (e.g. a gather node's Press-2 target happening to sit before its Press-1 target
      // in that array) and land a sibling in the wrong column.
      function computeAutoLayout(nodes) {
        var byId = {};
        nodes.forEach(function (n) { byId[n.id] = n; });

        var rank = {};
        var orderPerRank = {};
        function place(id, r) {
          rank[id] = r;
          if (!orderPerRank[r]) orderPerRank[r] = [];
          orderPerRank[r].push(id);
        }

        var queue = entryNodeId ? [entryNodeId] : [];
        if (entryNodeId) place(entryNodeId, 0);
        while (queue.length > 0) {
          var currentId = queue.shift();
          var current = byId[currentId];
          if (!current) continue;
          outgoingRefs(current).forEach(function (nextId) {
            if (!(nextId in rank) && byId[nextId]) {
              place(nextId, rank[currentId] + 1);
              queue.push(nextId);
            }
          });
        }

        var maxRank = 0;
        Object.keys(rank).forEach(function (id) { if (rank[id] > maxRank) maxRank = rank[id]; });
        // Nodes the BFS never reached (unpointed-to nodes) still fall back to the "nodes" array's
        // order, but each one gets its own brand-new trailing rank -- so there are never two
        // such nodes sharing a rank, and no branch-order guarantee is needed for them.
        nodes.forEach(function (n) {
          if (!(n.id in rank)) {
            maxRank += 1;
            place(n.id, maxRank);
          }
        });

        var countPerRank = {};
        var positions = {};
        Object.keys(orderPerRank).forEach(function (r) {
          var ids = orderPerRank[r];
          countPerRank[r] = ids.length;
          ids.forEach(function (id, col) {
            positions[id] = { x: col * COLUMN_WIDTH + 40, y: Number(r) * RANK_HEIGHT + TOP_MARGIN + 40 };
          });
        });

        // Center each rank as a block relative to the widest rank -- without this, a rank with
        // fewer nodes than its neighbors (almost always rank 0, the lone entry node) sits jammed
        // against the left edge instead of centered above its children, which is what makes the
        // Aircall reference read as a clean tree rather than a lopsided fan.
        var maxRankWidth = 0;
        Object.keys(countPerRank).forEach(function (r) {
          maxRankWidth = Math.max(maxRankWidth, countPerRank[r] * COLUMN_WIDTH);
        });
        nodes.forEach(function (n) {
          var r = rank[n.id];
          var offset = (maxRankWidth - countPerRank[r] * COLUMN_WIDTH) / 2;
          positions[n.id].x += offset;
        });

        return { positions: positions, maxRank: maxRank };
      }

      function truncate(s, n) {
        s = String(s == null ? '' : s);
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
      }

      // Icon/color/label per node type, and a one-line human summary of that node's config --
      // this is what turns the card from "raw id + type" into something readable at a glance,
      // matching the Aircall reference's icon+title+subtitle card style.
      var NODE_META = {
        date_rule: { icon: '\u{1F4C5}', color: '#7c5cff', label: 'Date rule' },
        business_hours: { icon: '\u{1F550}', color: '#7c5cff', label: 'Time rule' },
        play: { icon: '▶', color: '#2f7bf6', label: 'Audio Message' },
        gather: { icon: '⌨', color: '#7c5cff', label: 'Standard IVR' },
        input: { icon: '\u{1F522}', color: '#d1443b', label: 'Input IVR' },
        wait: { icon: '⏳', color: '#2f7bf6', label: 'Waiting experience' },
        ring: { icon: '\u{1F4DE}', color: '#1f9d55', label: 'Ring to' },
        redirect: { icon: '↪', color: '#1f9d55', label: 'Redirect to' },
        voicemail: { icon: '\u{1F4FC}', color: '#e08a1e', label: 'Voicemail' }
      };

      function subtitleForNode(node) {
        var c = node.config || {};
        if (node.type === 'business_hours') return 'Routes by business hours';
        if (node.type === 'date_rule') {
          var dn = Array.isArray(c.closedDates) ? c.closedDates.length : 0;
          return dn + ' closed date' + (dn === 1 ? '' : 's') + ' (holidays)';
        }
        if (node.type === 'play') return c.ttsText ? truncate(c.ttsText, 40) : (c.audioAssetId ? 'Plays uploaded audio' : 'No content set');
        if (node.type === 'gather') {
          var n = Array.isArray(c.options) ? c.options.length : 0;
          return n + ' option' + (n === 1 ? '' : 's') + (c.ttsText ? ': ' + truncate(c.ttsText, 30) : '');
        }
        if (node.type === 'input') return 'Collects ' + (c.numDigits || '?') + ' digits' + (c.ttsText ? ': ' + truncate(c.ttsText, 25) : '');
        if (node.type === 'ring') {
          var targetLabel = c.target === 'all' ? 'all available staff' : (Array.isArray(c.target) ? c.target.length + ' staff member' + (c.target.length === 1 ? '' : 's') : 'staff');
          return 'Ring ' + targetLabel + ' for ' + c.timeoutSeconds + 's (' + c.strategy + ')';
        }
        if (node.type === 'redirect') return 'Forward to ' + (c.number || 'a number');
        if (node.type === 'wait') return 'Hold experience' + (c.allowCallbackStar ? ' + callback (*)' : '');
        if (node.type === 'voicemail') return 'Mailbox: ' + (c.mailboxLabel || 'default');
        return '';
      }

      // A one-line "this step has a dead-end" warning, shown on the card. Focused on the case that
      // actually breaks a live call: a Ring step with no "if nobody answers" step falls through to
      // an error instead of voicemail.
      function nodeWarning(node) {
        var c = node.config || {};
        if (node.type === 'ring' && !c.noAnswerNextNodeId) return 'No "if nobody answers" step set';
        return '';
      }

      function nodeHtml(node, branchLabel) {
        var meta = NODE_META[node.type] || { icon: '●', color: '#6b7280', label: node.type };
        var badge = branchLabel ? '<div class="ivr-branch-label">' + escText(branchLabel) + '</div>' : '';
        var warn = nodeWarning(node);
        return badge +
          '<div class="ivr-node-card' + (warn ? ' ivr-node-card-warn' : '') + '">' +
          '<div class="ivr-node-icon" style="background:' + meta.color + '">' + meta.icon + '</div>' +
          '<div class="ivr-node-body">' +
          '<div class="ivr-node-title">' + escText(meta.label) + '</div>' +
          '<div class="ivr-node-subtitle">' + escText(subtitleForNode(node)) + '</div>' +
          (warn ? '<div class="ivr-node-warn">⚠ ' + escText(warn) + '</div>' : '') +
          '<div class="ivr-node-idsmall">' + escText(node.id) + '</div>' +
          '</div></div>';
      }

      // Rendered for a reference target that isn't one of this flow's own nodes -- e.g.
      // shared_voicemail, which is tagged flow='main' but referenced as the no-answer/default
      // target from after_hours nodes too. listNodesForFlow() (both the page route and
      // GET/PUT /api/ivr/flows/:flow) scopes strictly by the flow column, so currentNodes
      // never contains these. Rather than silently dropping the connection, draw a dashed,
      // non-editable stub node so the cross-flow reference is visible on the canvas.
      function externalNodeHtml(id) {
        return '<div class="ivr-node-card ivr-node-card-external">' +
          '<div class="ivr-node-icon" style="background:#9ca3af">↗</div>' +
          '<div class="ivr-node-body">' +
          '<div class="ivr-node-title">Shared node</div>' +
          '<div class="ivr-node-subtitle">In another flow</div>' +
          '<div class="ivr-node-idsmall">' + escText(id) + '</div>' +
          '</div></div>';
      }

      // Decorative start/end-of-call markers -- never part of currentNodes, never saved, never
      // openable in the edit panel (openEditPanel's existing currentNodes lookup naturally
      // no-ops for any id that isn't a real node, same as it already does for external stubs).
      function pillHtml(text, icon) {
        return '<div class="ivr-pill"><span>' + escText(icon) + '</span>' + escText(text) + '</div>';
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

      // Rewrites every Drawflow connection's default Bezier path into a crisp orthogonal
      // ("step") path with small hollow "junction dot" markers at the bends, matching the
      // Aircall reference's line style. Drawflow renders each connection as its own
      // <svg class="connection node_in_node-X node_out_node-Y output_N input_1"> holding one
      // <path class="main-path"> -- confirmed live via devtools before writing this, not
      // guessed. Those class names tell us exactly which drawflow node/output produced each
      // path, and since that <svg> has no viewBox/zoom transform (overflow: visible, 1:1 CSS
      // pixels), the path's existing "d" endpoints are already the correct canvas-space
      // coordinates -- reading them back out of the (about-to-be-replaced) Bezier "d" string
      // via a numeric-token regex avoids re-deriving them through getBoundingClientRect, which
      // would additionally require unwinding Drawflow's pan/zoom transform.
      //
      // Fan-out (a card with more than one output) is visually collapsed to a single shared
      // trunk: Drawflow spaces each output port a few px apart along the card's bottom edge, so
      // without this every branch would start from a slightly different x and read as a "spider"
      // of near-parallel lines instead of the reference's one-trunk-then-fan-out. Grouping
      // connections by their shared "node_out_node-<id>" class and averaging the min/max of
      // their original x1 (which -- because Drawflow centers a node's output-port row -- lands
      // exactly on that card's true center-x) gives that single trunk x for free, no DOM
      // measurement needed. The merge side needs no equivalent fix: every real/pill/stub node
      // here has exactly one input port (see the addNode calls below), so incoming connections
      // already land on a single point.
      //
      // Only reapplied on the INITIAL render and after a completed drag (see the 'nodeMoved'
      // handler below) -- Drawflow redraws its own default Bezier continuously while a node is
      // being dragged, and re-fighting that on every mousemove isn't worth it; accepting a brief
      // Bezier flash mid-drag that snaps back to orthogonal on release is the reasonable
      // trade-off here (this file has no test coverage for canvas rendering either way).
      // forceStraightOutIds: drawflow ids whose OWN single outgoing connection should always be
      // rendered as a plain straight drop, x1 snapped to x2, even past the small-offset
      // threshold below -- used for the "Call comes in" pill, which is placed directly above the
      // entry node by design (see buildCanvas) but whose narrower pill card centers its output
      // port a bit left/right of the (wider) node card's centered input port, otherwise reading
      // as a spurious jog that doesn't exist in the reference for this always-aligned pairing.
      function applyOrthogonalConnections(forceStraightOutIds) {
        var forceStraight = {};
        (forceStraightOutIds || []).forEach(function (id) { forceStraight[id] = true; });
        var connections = document.querySelectorAll('#drawflow .connection');
        var groups = {};
        connections.forEach(function (conn) {
          var cls = conn.getAttribute('class') || '';
          // NOTE: doubled backslashes below (\\S, \\d, \\.) are deliberate, not a typo -- this
          // whole <script> body is itself one big TS template literal, so a single "\S"/"\d"/"\."
          // written here would be treated as an unrecognized string escape at TS-compile time and
          // have its backslash silently dropped (leaving a literal "S"/"d"/"." in the emitted JS,
          // silently breaking the regex) -- confirmed by hitting exactly that bug live in-browser
          // while building this. Doubling produces one real backslash in the runtime string.
          var outMatch = cls.match(/node_out_node-(\\S+)/);
          var path = conn.querySelector('.main-path');
          if (!outMatch || !path) return;
          var d = path.getAttribute('d') || '';
          var nums = (d.match(/-?\\d+(\\.\\d+)?/g) || []).map(Number);
          if (nums.length < 4) return;
          var key = outMatch[1];
          if (!groups[key]) groups[key] = [];
          groups[key].push({
            conn: conn,
            path: path,
            x1: nums[0],
            y1: nums[1],
            x2: nums[nums.length - 2],
            y2: nums[nums.length - 1],
          });
        });

        Object.keys(groups).forEach(function (key) {
          var items = groups[key];
          var xs = items.map(function (it) { return it.x1; });
          var trunkX = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
          var snapStraight = !!forceStraight[key];

          items.forEach(function (it) {
            it.conn.querySelectorAll('circle.ivr-bend-dot').forEach(function (dot) { dot.remove(); });

            var x1 = snapStraight ? it.x2 : trunkX, y1 = it.y1, x2 = it.x2, y2 = it.y2, d;
            if (snapStraight || Math.abs(x1 - x2) < 4) {
              // Same column as its target (a straight chain, e.g. parent directly above child) --
              // a plain vertical/near-vertical line with no bend, so no junction dots either,
              // matching the reference's undotted straight runs.
              d = 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;
            } else {
              var ym = (y1 + y2) / 2;
              d = 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + ym + ' L ' + x2 + ' ' + ym + ' L ' + x2 + ' ' + y2;
              [[x1, ym], [x2, ym]].forEach(function (pt) {
                var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot.setAttribute('class', 'ivr-bend-dot');
                dot.setAttribute('cx', pt[0]);
                dot.setAttribute('cy', pt[1]);
                dot.setAttribute('r', 3.5);
                it.conn.appendChild(dot);
              });
            }
            it.path.setAttribute('d', d);
          });
        });
      }

      function buildCanvas() {
        var container = document.getElementById('drawflow');
        editor = new Drawflow(container);
        editor.reroute = true;
        // Drawflow's connector path is a cubic bezier whose control points sit "curvature" of the
        // way along the horizontal gap between the two endpoints (see createCurvature in
        // drawflow.min.js) -- the default 0.5 is tuned for wide, lazy S-curves between left/right
        // ports on a horizontal flow diagram. Combined with the top/bottom port CSS above, a low
        // curvature keeps each path hugging close to vertical near both ends and only bends where
        // a branch's target column is genuinely offset from its source, which is as close to the
        // reference's clean mostly-straight/orthogonal look as a bezier-only renderer gets without
        // forking Drawflow to draw real right-angle paths (out of scope for this fix).
        editor.curvature = 0.18;
        editor.reroute_curvature_start_end = 0.18;
        editor.reroute_curvature = 0.18;
        editor.start();

        var layout = computeAutoLayout(currentNodes);
        var autoPositions = layout.positions;

        // Precompute each node's incoming branch label (first writer wins for a target reached
        // via more than one path -- e.g. a shared voicemail node -- since a card only has room
        // for one badge; this is a deliberate simplification, not a bug).
        var incomingLabel = {};
        currentNodes.forEach(function (node) {
          outputHandlesForType(node).forEach(function (h) {
            if (h.target && h.label && !(h.target in incomingLabel)) {
              incomingLabel[h.target] = h.label;
            }
          });
        });

        function posOf(node) {
          return (node.positionX != null && node.positionY != null)
            ? { x: node.positionX, y: node.positionY }
            : autoPositions[node.id];
        }

        // Tracks each real node's ACTUAL rendered position (which respects a stored drag, not
        // just the raw auto-layout guess) so the synthetic pills placed relative to a node below
        // stay aligned with it even after that node has been dragged away from its auto position.
        var renderedPos = {};

        currentNodes.forEach(function (node) {
          var pos = posOf(node);
          renderedPos[node.id] = pos;
          var numOutputs = outputsCountForType(node);
          var drawflowId = editor.addNode(node.type, 1, numOutputs, pos.x, pos.y, 'ivr-node', { ivrNodeId: node.id }, nodeHtml(node, incomingLabel[node.id]));
          drawflowIdToIvrId[drawflowId] = node.id;
          ivrIdToDrawflowId[node.id] = drawflowId;
        });

        // Synthetic "Call comes in" pill -- purely decorative, never registered in
        // ivrIdToDrawflowId since nothing ever targets it. Always shown, even on a totally
        // empty flow (no entry node yet): a blank canvas with no visible starting point reads
        // as broken rather than "nothing built here yet". With an entry node, it's placed
        // directly above it and connected; without one, it just sits at a fixed top-left spot
        // as an orientation marker for whatever gets added first.
        var startPillId;
        if (entryNodeId && ivrIdToDrawflowId[entryNodeId] != null) {
          var entryPos = renderedPos[entryNodeId] || { x: 40, y: 40 };
          startPillId = editor.addNode('pill_start', 0, 1, entryPos.x, entryPos.y - RANK_HEIGHT, 'ivr-pill-node', {}, pillHtml('Call comes in', '\u{1F4DE}'));
          editor.addConnection(startPillId, ivrIdToDrawflowId[entryNodeId], 'output_1', 'input_1');
        } else {
          startPillId = editor.addNode('pill_start', 0, 0, 40, 40, 'ivr-pill-node', {}, pillHtml('Call comes in', '\u{1F4DE}'));
        }

        // Single shared "Call ends" pill for the whole canvas -- every ring node's answered
        // outcome and every voicemail node's terminal outcome (registered under the same
        // "__pill_call_ends" id outputHandlesForType already targets) converge into this one
        // node, reusing the exact same connection-drawing pass below with no special-casing.
        // Matches the Aircall reference's single end-of-call marker instead of one pill per
        // branch. Positioned centered under, and one rank below, the lowest of those sources.
        var terminalSourceNodes = currentNodes.filter(function (n) { return n.type === 'ring' || n.type === 'voicemail'; });
        if (terminalSourceNodes.length > 0) {
          var terminalSumX = 0, terminalMaxY = 0;
          terminalSourceNodes.forEach(function (n) {
            var pos = renderedPos[n.id];
            terminalSumX += pos.x;
            if (pos.y > terminalMaxY) terminalMaxY = pos.y;
          });
          var endPillDrawflowId = editor.addNode('pill_end', 1, 0, terminalSumX / terminalSourceNodes.length, terminalMaxY + RANK_HEIGHT, 'ivr-pill-node', {}, pillHtml('Call ends', '☎'));
          ivrIdToDrawflowId['__pill_call_ends'] = endPillDrawflowId;
        }

        // Cross-flow reference targets (see externalNodeHtml above) get a dashed stub node of
        // their own, in an extra row below every real node this flow has.
        var externalTargetIds = [];
        currentNodes.forEach(function (node) {
          outputHandlesForType(node).forEach(function (h) {
            if (h.target && !(h.target in ivrIdToDrawflowId) && externalTargetIds.indexOf(h.target) === -1) {
              externalTargetIds.push(h.target);
            }
          });
        });
        externalTargetIds.forEach(function (targetId, idx) {
          var stubX = idx * COLUMN_WIDTH + 40;
          var stubY = (layout.maxRank + 2) * RANK_HEIGHT + TOP_MARGIN + 40;
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

        applyOrthogonalConnections(typeof startPillId !== 'undefined' ? [startPillId] : []);

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
          applyOrthogonalConnections(typeof startPillId !== 'undefined' ? [startPillId] : []);
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

      var addingNewNode = false;

      function openEditPanel(ivrId) {
        var node = currentNodes.filter(function (n) { return n.id === ivrId; })[0];
        if (!node) return;
        editingIvrId = ivrId;
        addingNewNode = false;
        document.getElementById('save-status').textContent = '';
        document.getElementById('edit-panel-fields').innerHTML = buildFieldsHtml(node, false);
        document.getElementById('edit-panel').classList.add('open');
      }

      // A blank starting point for a brand-new node -- 'play' is the simplest type to fill in
      // (a message + where to go next), so it's a reasonable default rather than leaving every
      // field empty against an arbitrary type.
      function openAddPanel() {
        editingIvrId = null;
        addingNewNode = true;
        document.getElementById('save-status').textContent = '';
        var blank = { id: '', type: 'play', config: { audioAssetId: null, ttsText: '', nextNodeId: '' } };
        document.getElementById('edit-panel-fields').innerHTML = buildFieldsHtml(blank, true);
        document.getElementById('edit-panel').classList.add('open');
      }

      document.getElementById('add-node-btn').addEventListener('click', openAddPanel);

      document.getElementById('close-panel-btn').addEventListener('click', function () {
        document.getElementById('edit-panel').classList.remove('open');
        editingIvrId = null;
        addingNewNode = false;
      });

      document.getElementById('save-node-btn').addEventListener('click', async function () {
        var updated = collectNodeFromPanel();
        var status = document.getElementById('save-status');
        var newId = null;
        // Snapshot so a failed save can restore entryNodeId exactly, whether it moved via the
        // forced-first-node auto-entry path below or via the entry checkbox.
        var previousEntryNodeId = entryNodeId;
        var entryCheckbox = document.getElementById('panel-entry-checkbox');

        if (addingNewNode) {
          newId = document.getElementById('panel-id-input').value.trim();
          if (!newId) {
            status.textContent = 'Enter an ID for the new node.';
            return;
          }
          if (currentNodes.some(function (n) { return n.id === newId; })) {
            status.textContent = 'A node with that ID already exists.';
            return;
          }
          currentNodes.push({ id: newId, type: updated.type, config: updated.config, positionX: null, positionY: null });
          // The very first node in an empty flow has to be the entry node -- the save API
          // requires entryNodeId to match exactly one node in the payload, so an empty flow
          // could never save its first node otherwise. For any later add, the checkbox (checked
          // and disabled in the forced case, checkable otherwise -- see buildFieldsHtml) decides.
          if (entryNodeId === null) {
            entryNodeId = newId;
          } else if (entryCheckbox && entryCheckbox.checked) {
            entryNodeId = newId;
          }
        } else {
          if (!editingIvrId) return;
          var node = currentNodes.filter(function (n) { return n.id === editingIvrId; })[0];
          node.type = updated.type;
          node.config = updated.config;
          if (entryCheckbox && entryCheckbox.checked) {
            entryNodeId = editingIvrId;
          }
        }

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
        if (!res.ok) {
          // Roll back the optimistic local edit so a failed save doesn't leave currentNodes
          // (or entryNodeId) out of sync with what's actually persisted.
          if (addingNewNode) {
            currentNodes = currentNodes.filter(function (n) { return n.id !== newId; });
          }
          entryNodeId = previousEntryNodeId;
          var text = await res.text();
          status.textContent = 'Failed to save: ' + text;
          return;
        }
        if (addingNewNode) {
          // A brand-new node changes the graph's topology (ranks/columns/trunk lines) --
          // simplest and safest to let the next full page load recompute layout fresh, same
          // reasoning as the delete-node reload.
          location.reload();
        } else {
          status.textContent = 'Saved.';
          document.getElementById('edit-panel').classList.remove('open');
          editingIvrId = null;
        }
      });

      // "Add a new step here" from any "go to" dropdown: creates a new step (a voicemail -- the
      // only type valid with no onward reference, so the save always passes -- which the user then
      // retypes/edits), wires this field to it, saves the whole flow, and reopens the new step's
      // editor after reload. This is the one-click "add connected step" from Aircall.
      document.getElementById('edit-panel-fields').addEventListener('change', function (e) {
        var sel = e.target;
        if (!sel || !sel.classList || !sel.classList.contains('ivr-next-select') || sel.value !== '__new__') return;
        var newId = 'step_' + Date.now().toString(36);
        currentNodes.push({ id: newId, type: 'voicemail', config: { audioAssetId: null, ttsText: '', mailboxLabel: 'New step' }, positionX: null, positionY: null });
        var opt = document.createElement('option');
        opt.value = newId;
        opt.textContent = 'Voicemail · New step';
        sel.insertBefore(opt, sel.lastChild);
        sel.value = newId;
        try { sessionStorage.setItem('ivrOpenNode', newId); } catch (err) {}
        document.getElementById('save-node-btn').click();
      });

      // Nodes that still point AT targetId -- reuses the same outgoingRefs() the auto-layout
      // and connection-drawing code already rely on, so "who references this node" can never
      // drift out of sync with what actually gets saved/validated server-side.
      function referencingNodes(targetId) {
        return currentNodes.filter(function (n) {
          return n.id !== targetId && outgoingRefs(n).indexOf(targetId) !== -1;
        });
      }

      document.getElementById('delete-node-btn').addEventListener('click', async function () {
        if (!editingIvrId) return;
        var status = document.getElementById('save-status');
        var deleteId = editingIvrId;

        if (deleteId === entryNodeId) {
          status.textContent = "Can't delete the entry node -- set a different node as the entry first.";
          return;
        }
        var referencing = referencingNodes(deleteId);
        if (referencing.length > 0) {
          var names = referencing.map(function (n) { return n.id; }).join(', ');
          status.textContent = 'Still referenced by: ' + names + ' -- repoint those first.';
          return;
        }
        if (!window.confirm('Delete node "' + deleteId + '"? This cannot be undone.')) {
          return;
        }

        var remainingNodes = currentNodes.filter(function (n) { return n.id !== deleteId; });
        var payload = {
          entryNodeId: entryNodeId,
          nodes: remainingNodes.map(function (n) {
            return { id: n.id, type: n.type, config: n.config, positionX: n.positionX, positionY: n.positionY };
          }),
        };
        var res = await fetch('/api/ivr/flows/' + encodeURIComponent(FLOW), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          // Removing a node changes the whole graph's topology (ranks/columns/trunks), so a
          // full reload -- re-running the same auto-layout/connection-drawing pass a fresh page
          // load already does -- is simpler and safer than trying to live-patch Drawflow's
          // internal node/connection DOM state to match.
          location.reload();
        } else {
          var text = await res.text();
          status.textContent = 'Failed to delete: ' + text;
        }
      });

      document.getElementById('edit-panel-fields').addEventListener('click', function (e) {
        var t = e.target;
        var pickerBtn = t.closest('.ivr-type-picker-btn');
        var pickerRow = t.closest('.ivr-type-picker-row');
        if (pickerBtn) {
          var list = document.getElementById('panel-type-picker-list');
          list.style.display = list.style.display === 'none' ? 'block' : 'none';
        } else if (pickerRow) {
          var newType = pickerRow.getAttribute('data-type');
          var select = document.getElementById('panel-type-select');
          select.value = newType;
          document.getElementById('panel-type-picker-btn').innerHTML = typePickerBtnHtml(newType);
          document.getElementById('panel-type-picker-list').style.display = 'none';
          document.querySelectorAll('#panel-type-picker-list .ivr-type-picker-row').forEach(function (r) {
            r.classList.toggle('selected', r.getAttribute('data-type') === newType);
          });
          toggleFields(select);
        } else if (t.classList.contains('add-option-btn')) {
          var group = t.closest('.field-group');
          var optList = group.querySelector('.gather-options-list');
          var div = document.createElement('div');
          div.innerHTML = gatherOptionRowHtml(null);
          optList.appendChild(div.firstChild);
        } else if (t.classList.contains('remove-option-btn')) {
          t.closest('.gather-option-row').remove();
        }
      });

      // Closes the type picker's popup list when clicking anywhere outside it (the panel is
      // re-rendered fresh on every openEditPanel() call, so this only needs registering once here
      // rather than per-render).
      document.addEventListener('click', function (e) {
        var picker = document.getElementById('panel-type-picker');
        if (!picker || picker.contains(e.target)) return;
        var list = document.getElementById('panel-type-picker-list');
        if (list) list.style.display = 'none';
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

      // ---- Zoom / fit-to-screen. The whole flow (nodes + connection SVGs) lives inside
      // editor.precanvas, so scaling/translating that one element pans+zooms everything together;
      // connection path coords are in pre-transform space, so they need no recompute here.
      function nodesBBox() {
        var els = editor.precanvas.querySelectorAll('.drawflow-node');
        if (!els.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        els.forEach(function (el) {
          var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
          var w = el.offsetWidth, h = el.offsetHeight;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x + w > maxX) maxX = x + w;
          if (y + h > maxY) maxY = y + h;
        });
        return { minX: minX, minY: minY, w: maxX - minX, h: maxY - minY };
      }
      function applyTransform(z, tx, ty) {
        editor.zoom = z;
        editor.canvas_x = tx;
        editor.canvas_y = ty;
        editor.zoom_last_value = z;
        editor.precanvas.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + z + ')';
      }
      function fitView() {
        var box = nodesBBox();
        if (!box || !editor.container) return;
        var vw = editor.container.clientWidth, vh = editor.container.clientHeight, pad = 70;
        var z = Math.min((vw - pad * 2) / Math.max(box.w, 1), (vh - pad * 2) / Math.max(box.h, 1), 1);
        z = Math.max(z, 0.25);
        applyTransform(z, (vw - box.w * z) / 2 - box.minX * z, pad - box.minY * z);
      }
      function zoomBy(factor) {
        var old = editor.zoom || 1;
        var z = Math.max(0.25, Math.min(1.5, old * factor));
        var vw = editor.container.clientWidth, vh = editor.container.clientHeight;
        var tx = vw / 2 - (vw / 2 - (editor.canvas_x || 0)) * (z / old);
        var ty = vh / 2 - (vh / 2 - (editor.canvas_y || 0)) * (z / old);
        applyTransform(z, tx, ty);
      }
      (function () {
        var f = document.getElementById('zoom-fit'); if (f) f.addEventListener('click', fitView);
        var i = document.getElementById('zoom-in'); if (i) i.addEventListener('click', function () { zoomBy(1.2); });
        var o = document.getElementById('zoom-out'); if (o) o.addEventListener('click', function () { zoomBy(1 / 1.2); });
      })();

      if (window.Drawflow) {
        buildCanvas();
        setTimeout(fitView, 60);
        // If we just created a step via a "go to → add a new step" dropdown, reopen it for editing.
        try {
          var openId = sessionStorage.getItem('ivrOpenNode');
          if (openId) {
            sessionStorage.removeItem('ivrOpenNode');
            setTimeout(function () { openEditPanel(openId); }, 120);
          }
        } catch (err) {}
      } else {
        document.getElementById('cdn-error').style.display = 'block';
      }
      renderAudioAssetList();
    </script>`;

  return renderLayout(`IVR Flow: ${flow}`, "ivr", body, { extraHead: extraHead, fullWidth: true });
}
