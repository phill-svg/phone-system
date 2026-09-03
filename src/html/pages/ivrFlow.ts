import { renderLayout } from "../layout";
import type { IvrNode } from "../../db/ivrNodes";

// Custom visual IVR editor (no Drawflow). Steps are cards on a pannable canvas; you drag a card's
// labelled output handle onto another card (or empty space -> new step) to connect. Branch steps
// (open/closed hours, menu keys, ring "no answer") expose one handle per branch, each drawing its
// own line. Content is edited in the right-hand panel. Reads/writes the same model the flow engine
// runs on (each node's config carries its next-step id(s); positions persist via position_x/y).
//
// The page HTML is a template literal; the ONLY interpolation is ${dataJson}. The inline <script>
// must NOT contain backticks or ${...} — use "+" concatenation and quotes throughout.
export function renderIvrFlowPage(
  flow: string,
  nodes: IvrNode[],
  audioAssets: { id: string; label: string }[],
  staffEmails: string[]
): string {
  const entryNodeId = nodes.find((n) => n.isEntry)?.id ?? nodes[0]?.id ?? "";
  const dataJson = JSON.stringify({
    flow,
    entryNodeId,
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, config: n.config, x: n.positionX, y: n.positionY })),
    audio: audioAssets,
    staff: staffEmails,
  }).replace(/</g, "\\u003c");

  const extraHead = `<style>
    main.full-width { height: calc(100vh - 58px); display: flex; flex-direction: column; }
    .ivr-topbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--admin-border); flex-wrap: wrap; }
    .ivr-topbar h2 { margin: 0 auto 0 0; font-size: 1.05rem; }
    .ivr-btn { background: var(--admin-surface); color: var(--admin-text); border: 1px solid var(--admin-border); border-radius: 0.5rem; padding: 0.45rem 0.9rem; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
    .ivr-btn:hover { background: var(--admin-surface-hover); }
    .ivr-primary { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; }
    .ivr-status { font-size: 0.82rem; color: var(--admin-dim); }
    .ivr-main { flex: 1; display: flex; min-height: 0; }
    #ivrCanvasWrap { flex: 1; position: relative; overflow: auto; background: #0d0e11; background-image: radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px); background-size: 18px 18px; }
    #ivrCanvas { position: relative; width: 4000px; height: 3000px; }
    #ivrLines { position: absolute; top: 0; left: 0; width: 4000px; height: 3000px; pointer-events: none; }
    #ivrLines path { fill: none; stroke: #6b7280; stroke-width: 2; }
    #ivrLines path.temp { stroke: var(--admin-brand); stroke-dasharray: 5 4; }
    #ivrLines .lbl { fill: var(--admin-dim); font-size: 11px; }
    .node { position: absolute; width: 210px; background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 12px; box-shadow: 0 3px 10px rgba(0,0,0,0.4); user-select: none; }
    .node.sel { border-color: var(--admin-brand); box-shadow: 0 0 0 2px rgba(228,0,43,0.4); }
    .node-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem 0.65rem; cursor: grab; border-bottom: 1px solid var(--admin-border); }
    .node-head .nh-type { font-weight: 700; font-size: 0.85rem; }
    .node-entry { font-size: 0.6rem; text-transform: uppercase; background: rgba(228,0,43,0.2); color: #ff8ea0; padding: 0.1rem 0.35rem; border-radius: 0.3rem; }
    .node-x { margin-left: auto; background: none; border: none; color: var(--admin-mute); cursor: pointer; font-size: 0.9rem; }
    .node-x:hover { color: #ff8ea0; }
    .node-sum { padding: 0.45rem 0.65rem; font-size: 0.78rem; color: var(--admin-dim); min-height: 14px; }
    .node-outs { display: flex; flex-wrap: wrap; gap: 0.3rem; padding: 0.4rem 0.55rem 0.6rem; }
    .out { display: flex; align-items: center; gap: 0.25rem; font-size: 0.68rem; color: var(--admin-dim); background: var(--admin-bg); border: 1px solid var(--admin-border); border-radius: 999px; padding: 0.12rem 0.3rem 0.12rem 0.5rem; }
    .out-dot { width: 13px; height: 13px; border-radius: 50%; background: #6b7280; border: 2px solid var(--admin-surface); cursor: crosshair; }
    .out-dot:hover { background: var(--admin-brand); }
    .out.linked .out-dot { background: var(--admin-brand); }
    #ivrPanel { width: 320px; min-width: 320px; border-left: 1px solid var(--admin-border); background: var(--admin-surface); overflow-y: auto; padding: 0.9rem; }
    #ivrPanel .ph { color: var(--admin-mute); font-size: 0.85rem; text-align: center; margin-top: 2rem; }
    .pf { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.8rem; font-size: 0.8rem; color: var(--admin-dim); }
    .pf input[type=text], .pf input[type=number], .pf select, .pf textarea { font-size: 0.88rem; }
    .p-opt { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem; }
    .p-opt .p-key { width: 46px; text-align: center; }
    .ivr-link { background: none; border: none; color: #ff5c78; cursor: pointer; font-size: 0.8rem; padding: 0.1rem; }
    .ivr-add-menu { position: fixed; z-index: 60; background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); padding: 0.4rem; }
    .ivr-add-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--admin-text); padding: 0.45rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
    .ivr-add-menu button:hover { background: var(--admin-surface-hover); }
    .ivr-backdrop { position: fixed; inset: 0; z-index: 59; }
  </style>`;

  const body = `
    <div class="ivr-topbar">
      <h2>Call Flow</h2>
      <button id="addStep" class="ivr-btn">+ Add step</button>
      <button id="uploadAudio" class="ivr-btn">⬆ Upload audio</button>
      <input id="audioFile" type="file" accept="audio/*" style="display:none">
      <button id="arrange" class="ivr-btn">Auto-arrange</button>
      <button id="saveFlow" class="ivr-btn ivr-primary">Save</button>
      <span id="saveStatus" class="ivr-status"></span>
    </div>
    <div class="ivr-main">
      <div id="ivrCanvasWrap"><div id="ivrCanvas"><svg id="ivrLines"></svg></div></div>
      <div id="ivrPanel"><div class="ph">Click a step to edit it. Drag a handle to connect steps.</div></div>
    </div>
    <audio id="ivrPlayer" style="display:none"></audio>
    <script id="ivrData" type="application/json">${dataJson}</script>
    <script>
    (function(){
      var DATA = JSON.parse(document.getElementById("ivrData").textContent);
      var flow = DATA.flow, nodes = DATA.nodes, entryId = DATA.entryNodeId;
      var audio = DATA.audio || [], staff = DATA.staff || [];
      var selId = null;

      var TYPES = [
        ["play","Play message"], ["gather","Menu (press a key)"], ["ring","Ring staff"],
        ["voicemail","Voicemail"], ["wait","Hold / queue"], ["redirect","Forward to number"],
        ["input","Collect digits"], ["business_hours","Open / closed hours"], ["date_rule","Holiday / date rule"],
        ["callback","Request a callback"]
      ];
      function typeLabel(t){ for(var i=0;i<TYPES.length;i++){ if(TYPES[i][0]===t) return TYPES[i][1]; } return t; }
      function h(s){ var d=document.createElement("div"); d.textContent=(s==null?"":String(s)); return d.innerHTML; }
      function uid(){ return "n_"+Math.random().toString(36).slice(2,9); }
      function getNode(id){ for(var i=0;i<nodes.length;i++){ if(nodes[i].id===id) return nodes[i]; } return null; }

      function defaultConfig(type){
        if(type==="play") return {audioAssetId:null, ttsText:null, nextNodeId:""};
        if(type==="gather") return {audioAssetId:null, ttsText:null, options:[], defaultNextNodeId:"", retryLimit:3};
        if(type==="ring") return {target:"all", strategy:"simultaneous", timeoutSeconds:20, noAnswerNextNodeId:""};
        if(type==="voicemail") return {audioAssetId:null, ttsText:null, mailboxLabel:"Voicemail"};
        if(type==="wait") return {audioAssetId:null, ttsText:null, allowCallbackStar:false, nextNodeId:""};
        if(type==="redirect") return {number:""};
        if(type==="input") return {audioAssetId:null, ttsText:null, numDigits:4, nextNodeId:""};
        if(type==="business_hours") return {openNextNodeId:"", closedNextNodeId:""};
        if(type==="date_rule") return {closedDates:[], openNextNodeId:"", closedNextNodeId:""};
        if(type==="callback") return {audioAssetId:null, ttsText:null};
        return {};
      }
      // Outputs (branches) for a node: each has a key, a label, and either a plain config field or an option index.
      function outsFor(n){
        var c=n.config||{}, o=[];
        if(n.type==="play"||n.type==="input"||n.type==="wait") o.push({label:"Next", field:"nextNodeId"});
        else if(n.type==="gather"){ var opts=c.options||[]; for(var i=0;i<opts.length;i++){ o.push({label:"Press "+(opts[i].digit||"?"), opt:i}); } o.push({label:"No/invalid key", field:"defaultNextNodeId"}); }
        else if(n.type==="ring") o.push({label:"No answer", field:"noAnswerNextNodeId"});
        else if(n.type==="business_hours"){ o.push({label:"Open", field:"openNextNodeId"}); o.push({label:"Closed", field:"closedNextNodeId"}); }
        else if(n.type==="date_rule"){ o.push({label:"Normal day", field:"openNextNodeId"}); o.push({label:"Closed date", field:"closedNextNodeId"}); }
        return o;
      }
      function outTarget(n, out){ var c=n.config||{}; return out.opt!=null ? (c.options[out.opt]||{}).nextNodeId : c[out.field]; }
      function setOutTarget(n, out, val){ var c=n.config||{}; if(out.opt!=null) c.options[out.opt].nextNodeId=val; else c[out.field]=val; }

      function summary(n){
        var c=n.config||{};
        if(n.type==="redirect") return c.number||"(no number)";
        if(n.type==="voicemail") return c.mailboxLabel||"Voicemail";
        if(n.type==="callback" && !c.ttsText && !c.audioAssetId) return "Callback request";
        if(c.ttsText){ var t=String(c.ttsText); return t.length>34?t.slice(0,34)+"…":t; }
        if(c.audioAssetId){ for(var i=0;i<audio.length;i++){ if(audio[i].id===c.audioAssetId) return "▶ "+audio[i].label; } return "▶ recording"; }
        return "";
      }

      // ---- layout defaults ----
      function ensurePositions(){
        var col=0;
        for(var i=0;i<nodes.length;i++){ if(nodes[i].x==null||nodes[i].y==null){ nodes[i].x=60+(col%4)*240; nodes[i].y=60+Math.floor(col/4)*170; col++; } }
      }
      function autoArrange(){
        // simple BFS layering from entry
        var levels={}, seen={}, q=[[entryId,0]];
        while(q.length){ var it=q.shift(), id=it[0], lv=it[1]; if(!id||seen[id]) continue; seen[id]=true; var n=getNode(id); if(!n) continue; levels[id]=lv;
          var outs=outsFor(n); for(var k=0;k<outs.length;k++){ var tgt=outTarget(n,outs[k]); if(tgt) q.push([tgt,lv+1]); } }
        var rowCount={};
        for(var i=0;i<nodes.length;i++){ var nid=nodes[i].id; var lv=(nid in levels)?levels[nid]:0; if(!(lv in rowCount)) rowCount[lv]=0; nodes[i].y=60+lv*180; nodes[i].x=60+rowCount[lv]*250; rowCount[lv]++; }
        render();
      }

      // ---- rendering ----
      var canvas=document.getElementById("ivrCanvas"), svg=document.getElementById("ivrLines"), panel=document.getElementById("ivrPanel");
      function nodeEl(id){ return canvas.querySelector('[data-node="'+id+'"]'); }
      function render(){
        // remove existing node divs (keep svg)
        var olds=canvas.querySelectorAll(".node"); for(var i=0;i<olds.length;i++) olds[i].remove();
        for(var j=0;j<nodes.length;j++){ canvas.appendChild(buildNode(nodes[j])); }
        drawLines();
      }
      function buildNode(n){
        var d=document.createElement("div"); d.className="node"+(n.id===selId?" sel":""); d.setAttribute("data-node",n.id);
        d.style.left=(n.x||0)+"px"; d.style.top=(n.y||0)+"px";
        var head='<div class="node-head" data-drag="1"><span class="nh-type">'+h(typeLabel(n.type))+'</span>'+(n.id===entryId?'<span class="node-entry">Start</span>':'')+'<button class="node-x" title="Delete">✕</button></div>';
        var sum='<div class="node-sum">'+h(summary(n))+'</div>';
        var outs=outsFor(n), outsHtml='<div class="node-outs">';
        for(var i=0;i<outs.length;i++){ var linked=outTarget(n,outs[i])?" linked":""; outsHtml+='<span class="out'+linked+'"><span>'+h(outs[i].label)+'</span><span class="out-dot" data-out="'+i+'"></span></span>'; }
        outsHtml+='</div>';
        d.innerHTML=head+sum+outsHtml;
        return d;
      }
      function centerBottomOfOut(n, idx){
        var el=nodeEl(n.id); if(!el) return null; var dot=el.querySelectorAll(".out-dot")[idx]; if(!dot) return null;
        var cr=canvas.getBoundingClientRect(), dr=dot.getBoundingClientRect();
        return { x:(dr.left+dr.width/2 - cr.left), y:(dr.top+dr.height/2 - cr.top) };
      }
      function topOf(n){ var el=nodeEl(n.id); if(!el) return null; var cr=canvas.getBoundingClientRect(), r=el.getBoundingClientRect(); return { x:(r.left+r.width/2 - cr.left), y:(r.top - cr.top) }; }
      function pathD(a,b){ var my=(a.y+b.y)/2; return "M "+a.x+" "+a.y+" C "+a.x+" "+my+" "+b.x+" "+my+" "+b.x+" "+b.y; }
      function drawLines(){
        var html="";
        for(var i=0;i<nodes.length;i++){ var n=nodes[i], outs=outsFor(n);
          for(var k=0;k<outs.length;k++){ var tgt=outTarget(n,outs[k]); if(!tgt) continue; var t=getNode(tgt); if(!t) continue;
            var a=centerBottomOfOut(n,k), b=topOf(t); if(!a||!b) continue;
            html+='<path d="'+pathD(a,b)+'"></path>';
          } }
        svg.innerHTML=html;
      }

      // ---- side panel (content editing) ----
      function audioOpts(c){ var o='<option value="">— none —</option>'; for(var i=0;i<audio.length;i++){ o+='<option value="'+h(audio[i].id)+'"'+(c.audioAssetId===audio[i].id?" selected":"")+'>'+h(audio[i].label)+'</option>'; } return o; }
      function promptPanel(n,c){
        return '<label class="pf">Say (text-to-speech)<input type="text" data-fld="ttsText" value="'+h(c.ttsText||"")+'" placeholder="Thanks for calling TCB Pest Control"></label>'
          + '<label class="pf">…or play a recording<select data-fld="audioAssetId">'+audioOpts(c)+'</select></label>'
          + '<button type="button" class="ivr-link" id="pfPlay">▶ Preview recording</button>';
      }
      function panelFor(n){
        var c=n.config||{}, out='<div class="pf" style="color:var(--admin-text);font-weight:700">'+h(typeLabel(n.type))+'</div>';
        if(n.type==="play"||n.type==="input"||n.type==="wait"){ out+=promptPanel(n,c);
          if(n.type==="input") out+='<label class="pf">Digits to collect<input type="number" min="1" max="20" data-fld="numDigits" data-num="1" value="'+h(c.numDigits||4)+'"></label>';
          if(n.type==="wait") out+='<label class="pf"><span><input type="checkbox" data-fld="allowCallbackStar" data-bool="1"'+(c.allowCallbackStar?" checked":"")+'> Let caller press * for a callback</span></label>';
        } else if(n.type==="gather"){ out+=promptPanel(n,c);
          out+='<div class="pf">Menu keys (each key gets a line to drag)';
          var opts=c.options||[]; for(var i=0;i<opts.length;i++){ out+='<div class="p-opt"><input type="text" class="p-key" data-optkey="'+i+'" value="'+h(opts[i].digit||"")+'" placeholder="key"><button type="button" class="ivr-link p-delopt" data-opt="'+i+'">remove</button></div>'; }
          out+='<button type="button" class="ivr-link" id="pfAddOpt">+ Add key</button></div>';
          out+='<label class="pf">Retry limit (wrong keys allowed before the “No/invalid key” path)<input type="number" min="0" max="9" data-fld="retryLimit" data-num="1" value="'+h(c.retryLimit!=null?c.retryLimit:3)+'"></label>';
        } else if(n.type==="ring"){
          out+='<label class="pf">Who to ring<select data-fld="target" data-ringtarget="1"><option value="all"'+(c.target==="all"?" selected":"")+'>Everyone available</option><option value="some"'+(c.target!=="all"?" selected":"")+'>Specific staff…</option></select></label>';
          if(c.target!=="all"){ var sel=Array.isArray(c.target)?c.target:[]; out+='<div class="pf">Staff';
            for(var s=0;s<staff.length;s++){ var on=sel.indexOf(staff[s])>=0; out+='<label style="font-weight:400"><input type="checkbox" data-ringstaff="'+h(staff[s])+'"'+(on?" checked":"")+'> '+h(staff[s])+'</label>'; } out+='</div>'; }
          out+='<label class="pf">Ring style<select data-fld="strategy"><option value="simultaneous"'+(c.strategy!=="cascade"?" selected":"")+'>Everyone at once</option><option value="cascade"'+(c.strategy==="cascade"?" selected":"")+'>One at a time (cascade)</option></select></label>';
          out+='<label class="pf">Ring for (seconds)<input type="number" min="5" max="120" data-fld="timeoutSeconds" data-num="1" value="'+h(c.timeoutSeconds||20)+'"></label>';
        } else if(n.type==="voicemail"){ out+=promptPanel(n,c); out+='<label class="pf">Mailbox name<input type="text" data-fld="mailboxLabel" value="'+h(c.mailboxLabel||"")+'"></label>';
        } else if(n.type==="callback"){ out+=promptPanel(n,c);
          out+='<div class="pf" style="font-weight:400;opacity:0.75">Logs the caller&#39;s number as an open task on the Callbacks page, then hangs up. Nothing is recorded &mdash; use Voicemail if you want a message. Leave the prompt empty to use the default spoken line.</div>';
        } else if(n.type==="redirect"){ out+='<label class="pf">Forward to number<input type="text" data-fld="number" value="'+h(c.number||"")+'" placeholder="+61400000000"></label>';
        } else if(n.type==="business_hours"){ out+='<div class="pf">Drag the “Open” and “Closed” handles to the next steps.</div>';
        } else if(n.type==="date_rule"){ var dates=Array.isArray(c.closedDates)?c.closedDates.join(", "):""; out+='<label class="pf">Closed dates (comma separated, e.g. 2026-12-25)<input type="text" data-fld="closedDates" data-list="1" value="'+h(dates)+'"></label>'; }
        if(n.id!==entryId) out+='<button type="button" class="ivr-link" id="pfMakeStart">Make this the starting step</button>';
        return out;
      }
      function renderPanel(){
        var n=selId?getNode(selId):null;
        if(!n){ panel.innerHTML='<div class="ph">Click a step to edit it. Drag a handle to connect steps.</div>'; return; }
        panel.innerHTML=panelFor(n);
      }
      panel.addEventListener("input", function(ev){ var t=ev.target, n=getNode(selId); if(!n) return;
        if(t.getAttribute("data-optkey")!=null){ n.config.options[parseInt(t.getAttribute("data-optkey"),10)].digit=t.value; drawLines(); syncNode(n); return; }
        var fld=t.getAttribute("data-fld"); if(!fld) return;
        if(t.getAttribute("data-bool")){ n.config[fld]=t.checked; return; }
        if(t.getAttribute("data-num")){ n.config[fld]=parseInt(t.value,10)||0; return; }
        if(t.getAttribute("data-list")){ n.config[fld]=t.value.split(",").map(function(x){return x.trim();}).filter(function(x){return x;}); return; }
        if(fld==="audioAssetId"){ n.config.audioAssetId=t.value||null; if(t.value) n.config.ttsText=null; renderPanel(); syncNode(n); return; }
        if(fld==="ttsText"){ n.config.ttsText=t.value?t.value:null; if(t.value) n.config.audioAssetId=null; syncNode(n); return; }
        n.config[fld]=t.value; syncNode(n);
      });
      panel.addEventListener("change", function(ev){ var t=ev.target, n=getNode(selId); if(!n) return;
        if(t.getAttribute("data-ringtarget")){ n.config.target=(t.value==="all"?"all":[]); renderPanel(); return; }
        if(t.getAttribute("data-ringstaff")!=null){ var em=t.getAttribute("data-ringstaff"); if(!Array.isArray(n.config.target)) n.config.target=[]; var idx=n.config.target.indexOf(em); if(t.checked&&idx<0) n.config.target.push(em); if(!t.checked&&idx>=0) n.config.target.splice(idx,1); return; }
      });
      panel.addEventListener("click", function(ev){ var t=ev.target, n=getNode(selId); if(!n) return;
        if(t.id==="pfAddOpt"){ n.config.options.push({digit:"", nextNodeId:""}); renderPanel(); render(); return; }
        if(t.classList.contains("p-delopt")){ n.config.options.splice(parseInt(t.getAttribute("data-opt"),10),1); renderPanel(); render(); return; }
        if(t.id==="pfMakeStart"){ entryId=n.id; renderPanel(); render(); return; }
        if(t.id==="pfPlay"){ var aid=n.config.audioAssetId; if(!aid){ status("Pick a recording first.",false); return; } var pl=document.getElementById("ivrPlayer"); pl.src="/media/ivr-audio/"+encodeURIComponent(aid); pl.play().catch(function(){ status("Could not play.",false); }); return; }
      });
      function syncNode(n){ var el=nodeEl(n.id); if(el){ var s=el.querySelector(".node-sum"); if(s) s.textContent=summary(n); } }

      // ---- canvas interactions: select, drag-move, drag-connect ----
      var drag=null; // {mode:'move'|'connect', id, ...}
      canvas.addEventListener("mousedown", function(ev){
        var dot=ev.target.closest(".out-dot");
        var nodeDiv=ev.target.closest(".node");
        if(dot && nodeDiv){ // start connect
          ev.preventDefault();
          drag={mode:"connect", id:nodeDiv.getAttribute("data-node"), outIdx:parseInt(dot.getAttribute("data-out"),10)};
          return;
        }
        if(ev.target.closest(".node-x")) return; // handled on click
        var head=ev.target.closest('[data-drag]');
        if(head && nodeDiv){ // start move
          var n=getNode(nodeDiv.getAttribute("data-node")); var cr=canvas.getBoundingClientRect();
          drag={mode:"move", id:n.id, dx:(ev.clientX-cr.left)-n.x, dy:(ev.clientY-cr.top)-n.y};
          select(n.id);
        }
      });
      window.addEventListener("mousemove", function(ev){
        if(!drag) return; var cr=canvas.getBoundingClientRect(), x=ev.clientX-cr.left, y=ev.clientY-cr.top;
        if(drag.mode==="move"){ var n=getNode(drag.id); n.x=Math.max(0,x-drag.dx); n.y=Math.max(0,y-drag.dy); var el=nodeEl(n.id); el.style.left=n.x+"px"; el.style.top=n.y+"px"; drawLines(); }
        else if(drag.mode==="connect"){ var n2=getNode(drag.id); var a=centerBottomOfOut(n2,drag.outIdx); if(a){ svg.insertAdjacentHTML("beforeend", '<path class="temp" d="'+pathD(a,{x:x,y:y})+'"></path>'); var temps=svg.querySelectorAll("path.temp"); for(var i=0;i<temps.length-1;i++) temps[i].remove(); } }
      });
      window.addEventListener("mouseup", function(ev){
        if(!drag){ return; }
        if(drag.mode==="connect"){
          var srcN=getNode(drag.id), outs=outsFor(srcN), out=outs[drag.outIdx];
          var overNode=ev.target.closest(".node");
          if(overNode && overNode.getAttribute("data-node")!==drag.id){ setOutTarget(srcN,out,overNode.getAttribute("data-node")); }
          else if(!overNode){ var cr=canvas.getBoundingClientRect(); showAddMenu(ev.clientX, ev.clientY, {srcId:drag.id, outIdx:drag.outIdx, x:ev.clientX-cr.left, y:ev.clientY-cr.top}); }
          var t=svg.querySelectorAll("path.temp"); for(var i=0;i<t.length;i++) t[i].remove();
          drag=null; render(); return;
        }
        drag=null;
      });
      canvas.addEventListener("click", function(ev){
        if(ev.target.closest(".node-x")){ var nd=ev.target.closest(".node"); deleteNode(nd.getAttribute("data-node")); return; }
        var nodeDiv=ev.target.closest(".node"); if(nodeDiv && !ev.target.closest(".out-dot")) select(nodeDiv.getAttribute("data-node"));
      });
      function select(id){ selId=id; var all=canvas.querySelectorAll(".node"); for(var i=0;i<all.length;i++) all[i].classList.toggle("sel", all[i].getAttribute("data-node")===id); renderPanel(); }

      function addNode(type, x, y){ var n={id:uid(), type:type, config:defaultConfig(type), x:(x==null?80:x), y:(y==null?80:y)}; nodes.push(n); if(!entryId) entryId=n.id; return n; }
      function deleteNode(id){
        for(var i=nodes.length-1;i>=0;i--){ if(nodes[i].id===id){ nodes.splice(i,1); break; } }
        var flds=["nextNodeId","defaultNextNodeId","openNextNodeId","closedNextNodeId","noAnswerNextNodeId"];
        for(var k=0;k<nodes.length;k++){ var c=nodes[k].config||{}; for(var f=0;f<flds.length;f++){ if(c[flds[f]]===id) c[flds[f]]=""; } if(nodes[k].type==="gather"&&c.options){ for(var o=0;o<c.options.length;o++){ if(c.options[o].nextNodeId===id) c.options[o].nextNodeId=""; } } }
        if(entryId===id) entryId=nodes.length?nodes[0].id:"";
        if(selId===id){ selId=null; renderPanel(); }
        render();
      }

      // ---- add-step type menu ----
      var pendingConnect=null;
      function showAddMenu(clientX, clientY, pending){ pendingConnect=pending||null; closeAddMenu();
        var back=document.createElement("div"); back.className="ivr-backdrop"; back.id="ivrBackdrop"; back.addEventListener("mousedown", closeAddMenu); document.body.appendChild(back);
        var m=document.createElement("div"); m.className="ivr-add-menu"; m.id="ivrAddMenu"; var html="";
        for(var i=0;i<TYPES.length;i++){ html+='<button data-addtype="'+TYPES[i][0]+'">'+h(TYPES[i][1])+'</button>'; }
        m.innerHTML=html; m.style.left=Math.min(clientX, window.innerWidth-240)+"px"; m.style.top=Math.min(clientY, window.innerHeight-360)+"px";
        m.addEventListener("click", function(ev){ var b=ev.target.closest("[data-addtype]"); if(!b) return; var p=pendingConnect;
          var nx = p?p.x:120, ny=p?p.y:120; var n=addNode(b.getAttribute("data-addtype"), nx, ny);
          if(p){ var src=getNode(p.srcId); if(src){ setOutTarget(src, outsFor(src)[p.outIdx], n.id); } }
          pendingConnect=null; closeAddMenu(); render(); select(n.id);
        });
        document.body.appendChild(m);
      }
      function closeAddMenu(){ var m=document.getElementById("ivrAddMenu"); if(m) m.remove(); var b=document.getElementById("ivrBackdrop"); if(b) b.remove(); }

      // ---- toolbar ----
      function status(msg, ok){ var s=document.getElementById("saveStatus"); s.textContent=msg; s.style.color=ok?"#5ad19a":"#ff8ea0"; }
      document.getElementById("addStep").addEventListener("click", function(ev){ var r=ev.target.getBoundingClientRect(); showAddMenu(r.left, r.bottom+4, null); });
      document.getElementById("arrange").addEventListener("click", autoArrange);
      document.getElementById("saveFlow").addEventListener("click", save);
      var audioFile=document.getElementById("audioFile");
      document.getElementById("uploadAudio").addEventListener("click", function(){ audioFile.click(); });
      audioFile.addEventListener("change", function(){ var f=audioFile.files&&audioFile.files[0]; if(!f) return; var fd=new FormData(); fd.append("file",f); fd.append("label",f.name);
        status("Uploading “"+f.name+"”…", true);
        fetch("/api/ivr/audio",{method:"POST",credentials:"same-origin",body:fd}).then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t||("HTTP "+r.status)); }); return r.json(); })
          .then(function(res){ audio.push({id:res.id,label:f.name}); audioFile.value=""; status("Uploaded “"+f.name+"” ✓",true); renderPanel(); })
          .catch(function(e){ status("Upload failed: "+e.message,false); }); });

      function save(){
        for(var i=0;i<nodes.length;i++){ var n=nodes[i], c=n.config;
          if(n.type==="voicemail"&&!(c.mailboxLabel&&String(c.mailboxLabel).length)) return status("A Voicemail step needs a mailbox name.",false);
          if(n.type==="redirect"&&!(c.number&&String(c.number).length)) return status("A Forward step needs a phone number.",false);
          if(n.type==="gather"&&c.options){ for(var k=0;k<c.options.length;k++){ if(!(c.options[k].digit&&String(c.options[k].digit).length)) return status("A menu key is blank.",false); } }
        }
        if(!entryId||!getNode(entryId)) return status("Add a starting step first.",false);
        // The call renderer requires EXACTLY ONE of audioAssetId / ttsText (both-set throws). Coerce
        // empty tts to null and let a chosen recording win, so a step can never ship with both.
        for(var m=0;m<nodes.length;m++){ var cc=nodes[m].config; if(!cc||!("ttsText" in cc)) continue;
          if(cc.audioAssetId){ cc.ttsText=null; } else if(!cc.ttsText){ cc.ttsText=null; } }
        var payload={entryNodeId:entryId, nodes:nodes.map(function(n){ return {id:n.id, type:n.type, config:n.config, positionX:Math.round(n.x||0), positionY:Math.round(n.y||0)}; })};
        status("Saving…",true);
        fetch("/api/ivr/flows/"+encodeURIComponent(flow),{method:"PUT",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(payload)})
          .then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t||("HTTP "+r.status)); }); return r.json(); })
          .then(function(){ status("Saved ✓",true); }).catch(function(e){ status("Save failed: "+e.message,false); });
      }

      ensurePositions(); render();
    })();
    </script>`;

  return renderLayout("Call Flow: " + flow, "settings", extraHead + body, { role: "admin", fullWidth: true });
}
