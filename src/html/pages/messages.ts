import { renderLayout } from "../layout";

// Web/desktop SMS surface. Talks to the same /api/messages endpoints as the mobile app (cookie-authed
// on the dashboard). Client JS avoids backticks/${} so it can't break this template literal.
export function renderMessagesPage(role: "admin" | "staff" = "admin"): string {
  const style = `<style>
    main.full-width { height: calc(100vh - 58px); }
    .msg-wrap { display: flex; height: 100%; overflow: hidden; }
    .msg-list { width: 320px; min-width: 320px; border-right: 1px solid var(--admin-border); overflow-y: auto; background: var(--admin-surface); }
    .msg-list-head { display: flex; align-items: center; justify-content: space-between; padding: 0.8rem 1rem; border-bottom: 1px solid var(--admin-border); position: sticky; top: 0; background: var(--admin-surface); }
    .msg-list-head h2 { margin: 0; font-size: 1rem; }
    .conv { display: flex; gap: 0.7rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--admin-border); cursor: pointer; }
    .conv:hover { background: var(--admin-surface-hover); }
    .conv.active { background: var(--admin-surface-hover); }
    .conv-avatar { width: 40px; height: 40px; border-radius: 50%; background: #2a2d36; color: var(--admin-dim); display: flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; }
    .conv-main { flex: 1; min-width: 0; }
    .conv-top { display: flex; justify-content: space-between; gap: 0.5rem; }
    .conv-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .conv-time { color: var(--admin-mute); font-size: 0.72rem; white-space: nowrap; }
    .conv-last { color: var(--admin-dim); font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .conv-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--admin-brand); align-self: center; flex-shrink: 0; }
    .msg-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .msg-pane-head { padding: 0.8rem 1.1rem; border-bottom: 1px solid var(--admin-border); display: flex; align-items: center; gap: 0.6rem; min-height: 24px; }
    .msg-pane-head input { flex: 1; max-width: 260px; }
    .msg-scroll { flex: 1; overflow-y: auto; padding: 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .bubble-row { display: flex; }
    .bubble-row.out { justify-content: flex-end; }
    .bubble { max-width: 68%; padding: 0.5rem 0.75rem; border-radius: 14px; font-size: 0.9rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
    .bubble.in { background: var(--admin-surface); border: 1px solid var(--admin-border); }
    .bubble.out { background: var(--admin-brand); color: #fff; }
    .sms-from-row { padding: 0.4rem 1.1rem; border-top: 1px solid var(--admin-border); font-size: 0.8rem; color: var(--admin-dim); display: flex; align-items: center; gap: 0.5rem; }
    .sms-from-row select { font-size: 0.8rem; padding: 0.2rem 0.4rem; }
    .composer { display: flex; gap: 0.6rem; padding: 0.8rem 1.1rem; border-top: 1px solid var(--admin-border); }
    .composer textarea { flex: 1; resize: none; height: 40px; max-height: 120px; }
    .composer button { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; font-weight: 600; }
    .msg-empty { margin: auto; color: var(--admin-mute); text-align: center; }
    .pane-head-name { cursor: pointer; }
    .pane-head-name:hover { text-decoration: underline; }
    .contact-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .contact-modal-card { background: var(--admin-surface); border: 1px solid var(--admin-border); border-radius: 16px; padding: 1.6rem 1.5rem; width: min(340px, 90vw); text-align: center; box-shadow: 0 12px 48px rgba(0,0,0,0.55); }
    .contact-modal-avatar { width: 66px; height: 66px; border-radius: 50%; background: #2a2d36; color: var(--admin-dim); display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1.35rem; margin: 0 auto 0.85rem; }
    .contact-modal-name { font-size: 1.25rem; font-weight: 700; }
    .contact-modal-company { color: var(--admin-dim); font-size: 0.9rem; margin-top: 0.25rem; }
    .contact-modal-number { color: var(--admin-dim); font-size: 0.98rem; margin-top: 0.7rem; letter-spacing: 0.02em; }
    .contact-modal-actions { margin-top: 1.3rem; display: flex; gap: 0.6rem; justify-content: center; }
    .contact-modal-actions button { min-width: 84px; }
    .contact-modal-actions .cm-primary { background: var(--admin-brand); border-color: var(--admin-brand); color: #fff; font-weight: 600; }
  </style>`;

  const body =
    '<div class="msg-wrap">' +
      '<div class="msg-list">' +
        '<div class="msg-list-head"><h2>Messages</h2><button id="newBtn" title="New message">New</button></div>' +
        '<div id="convList"></div>' +
      '</div>' +
      '<div class="msg-pane">' +
        '<div class="msg-pane-head" id="paneHead"></div>' +
        '<div class="msg-scroll" id="scroll"><div class="msg-empty">Select a conversation, or start a new one.</div></div>' +
        '<div id="smsFromRow" class="sms-from-row" style="display:none"></div>' +
        '<div class="composer" id="composer" style="display:none">' +
          '<textarea id="text" placeholder="Text message" rows="1"></textarea>' +
          '<button id="sendBtn">Send</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="contactModal" class="contact-modal" style="display:none">' +
      '<div class="contact-modal-card">' +
        '<div class="contact-modal-avatar" id="cmAvatar"></div>' +
        '<div class="contact-modal-name" id="cmName"></div>' +
        '<div class="contact-modal-company" id="cmCompany"></div>' +
        '<div class="contact-modal-number" id="cmNumber"></div>' +
        '<div class="contact-modal-actions">' +
          '<button id="cmCall" class="cm-primary">Call</button>' +
          '<button id="cmClose">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<script>' + CLIENT_JS + '</script>';

  return renderLayout("Messages", "messages", style + body, { role, fullWidth: true });
}

// No backticks or ${} in here — this string is embedded inside a template literal above.
const CLIENT_JS = [
  'var current = null;',
  'var contactsByNorm = {};',
  // Must match normalizePhone() in src/db/contacts.ts (international 61x form) so a conversation number matches the stored phone_normalized.
  'function normalizePhoneJS(raw){ if(!raw) return ""; var hasPlus=String(raw).trim().charAt(0)==="+"; var d=String(raw).replace(/\\D/g,""); if(!d) return ""; if(hasPlus) return d; if(d.charAt(0)==="0") return "61"+d.slice(1); return d; }',
  'function resolveName(number){ var c=contactsByNorm[normalizePhoneJS(number)]; return c?c.name:null; }',
  // Display AU numbers in national form: +61/61 -> 0, grouped like "0472 762 158".
  'function formatAu(raw){ var s=String(raw==null?"":raw); var d=s.replace(/[^\\d+]/g,""); var n; if(d.charAt(0)==="+"){ n=d.indexOf("+61")===0?"0"+d.slice(3):d; } else if(d.indexOf("61")===0&&d.length>9){ n="0"+d.slice(2); } else { n=d; } if(/^04\\d{8}$/.test(n)) return n.slice(0,4)+" "+n.slice(4,7)+" "+n.slice(7); if(/^0[2378]\\d{8}$/.test(n)) return n.slice(0,2)+" "+n.slice(2,6)+" "+n.slice(6); if(/^13\\d{4}$/.test(n)) return n.slice(0,2)+" "+n.slice(2); if(/^1[38]00\\d{6}$/.test(n)) return n.slice(0,4)+" "+n.slice(4,7)+" "+n.slice(7); return n||s; }',
  'function loadContacts(){ return api("/api/contacts").then(function(list){ contactsByNorm={}; (list||[]).forEach(function(c){ if(c&&c.phone_normalized) contactsByNorm[c.phone_normalized]=c; }); }).catch(function(){}); }',
  'var smsNumbers=[];',
  'function loadNumbers(){ return api("/api/numbers").then(function(nums){ smsNumbers=(nums||[]).filter(function(n){return n.sms_enabled;}); }).catch(function(){}); }',
  // "From" row above the composer: 2+ SMS numbers => a dropdown; exactly 1 => a static line; 0 => hidden.
  'function renderSmsFromRow(){ var row=document.getElementById("smsFromRow"); if(!row) return; row.innerHTML=""; if(smsNumbers.length===0){ row.style.display="none"; return; } row.style.display="flex"; if(smsNumbers.length===1){ var s=document.createElement("span"); s.textContent="From "+smsNumbers[0].label+" · "+formatAu(smsNumbers[0].e164); row.appendChild(s); } else { var lbl=document.createElement("span"); lbl.textContent="From"; var sel=document.createElement("select"); sel.id="smsFromSelect"; smsNumbers.forEach(function(n){ var o=document.createElement("option"); o.value=n.e164; o.textContent=n.label+" · "+formatAu(n.e164); if(n.is_default_sms) o.selected=true; sel.appendChild(o); }); row.appendChild(lbl); row.appendChild(sel); } }',
  'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}',
  'function initials(s){s=(s||"").trim();if(!s)return "?";var p=s.replace(/[^0-9a-zA-Z ]/g,"").split(" ").filter(Boolean);if(p.length===0)return s.slice(-2);if(p.length===1)return p[0].slice(0,2).toUpperCase();return (p[0][0]+p[p.length-1][0]).toUpperCase();}',
  'function when(ms){var d=new Date(ms),n=new Date();if(d.toDateString()===n.toDateString())return d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"});return d.toLocaleDateString("en-AU",{day:"2-digit",month:"2-digit"});}',
  'function api(path,opts){return fetch(path,Object.assign({credentials:"same-origin",headers:{"Content-Type":"application/json"}},opts||{})).then(function(r){if(!r.ok)throw new Error(r.status);return r.status===204?null:r.json();});}',
  'function label(c){return c.name||resolveName(c.number)||formatAu(c.number);}',
  'function loadConversations(){return api("/api/messages").then(function(list){renderConversations(list||[]);}).catch(function(){});}',
  'function renderConversations(list){var el=document.getElementById("convList");if(list.length===0){el.innerHTML="<div class=\\"msg-empty\\" style=\\"padding:2rem 1rem\\">No conversations yet.</div>";return;}var html="";for(var i=0;i<list.length;i++){var c=list[i];var active=c.number===current?" active":"";html+="<div class=\\"conv"+active+"\\" data-num=\\""+esc(c.number)+"\\">"+"<div class=\\"conv-avatar\\">"+esc(initials(label(c)))+"</div>"+"<div class=\\"conv-main\\">"+"<div class=\\"conv-top\\"><span class=\\"conv-name\\">"+esc(label(c))+"</span><span class=\\"conv-time\\">"+esc(when(c.last_ts))+"</span></div>"+"<div class=\\"conv-last\\">"+esc(c.last_body)+"</div>"+"</div>"+(c.unread>0?"<span class=\\"conv-dot\\"></span>":"")+"</div>";}el.innerHTML=html;var nodes=el.querySelectorAll(".conv");for(var j=0;j<nodes.length;j++){nodes[j].addEventListener("click",function(){openThread(this.getAttribute("data-num"),this.querySelector(".conv-name").textContent);});}}',
  'function openThread(number,name){current=number;document.getElementById("composer").style.display="flex";renderSmsFromRow();var head=document.getElementById("paneHead");var c=contactsByNorm[normalizePhoneJS(number)];var disp=name||resolveName(number)||formatAu(number);if(c){head.innerHTML="<span class=\\"pane-head-name\\" id=\\"paneHeadName\\" title=\\"View contact\\"><strong>"+esc(disp)+"</strong></span>";var el=document.getElementById("paneHeadName");if(el)el.addEventListener("click",function(){showContactPreview(c,number);});}else{head.innerHTML="<strong>"+esc(disp)+"</strong>";}loadThread();loadConversations();}',
  'function showContactPreview(c,number){document.getElementById("cmAvatar").textContent=initials(c.name||c.phone||number);document.getElementById("cmName").textContent=c.name||formatAu(c.phone||number);var comp=document.getElementById("cmCompany");comp.textContent=c.company||"";comp.style.display=c.company?"block":"none";document.getElementById("cmNumber").textContent=formatAu(c.phone||number);document.getElementById("cmCall").onclick=function(){location.href="/admin/phone?dial="+encodeURIComponent(c.phone||number);};document.getElementById("contactModal").style.display="flex";}',
  'function hideContactPreview(){document.getElementById("contactModal").style.display="none";}',
  'function loadThread(){if(!current)return;api("/api/messages/"+encodeURIComponent(current)).then(function(msgs){renderThread(msgs||[]);}).catch(function(){});}',
  'function renderThread(msgs){var el=document.getElementById("scroll");if(msgs.length===0){el.innerHTML="<div class=\\"msg-empty\\">No messages yet. Send the first one below.</div>";return;}var html="";for(var i=0;i<msgs.length;i++){var m=msgs[i];var out=m.direction==="outbound";html+="<div class=\\"bubble-row "+(out?"out":"in")+"\\"><div class=\\"bubble "+(out?"out":"in")+"\\">"+esc(m.body)+"</div></div>";}el.innerHTML=html;el.scrollTop=el.scrollHeight;}',
  'function send(){var ta=document.getElementById("text");var body=ta.value.trim();if(!body||!current)return;var btn=document.getElementById("sendBtn");btn.disabled=true;var fs=document.getElementById("smsFromSelect");var payload={to:current,body:body};if(fs&&fs.value)payload.from=fs.value;api("/api/messages",{method:"POST",body:JSON.stringify(payload)}).then(function(){ta.value="";loadThread();loadConversations();}).catch(function(){alert("Could not send the message.");}).then(function(){btn.disabled=false;});}',
  'function newMessage(){var num=prompt("Send to (phone number):");if(!num)return;num=num.trim();if(!num)return;current=num;document.getElementById("composer").style.display="flex";renderSmsFromRow();document.getElementById("paneHead").innerHTML="<strong>"+esc(resolveName(num)||formatAu(num))+"</strong>";document.getElementById("scroll").innerHTML="<div class=\\"msg-empty\\">New message to "+esc(resolveName(num)||formatAu(num))+"</div>";document.getElementById("text").focus();}',
  'document.getElementById("cmClose").addEventListener("click",hideContactPreview);',
  'document.getElementById("contactModal").addEventListener("click",function(e){ if(e.target.id==="contactModal") hideContactPreview(); });',
  'document.addEventListener("keydown",function(e){ if(e.key==="Escape") hideContactPreview(); });',
  'document.getElementById("sendBtn").addEventListener("click",send);',
  'document.getElementById("newBtn").addEventListener("click",newMessage);',
  'document.getElementById("text").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});',
  'loadContacts().then(loadConversations);',
  'loadNumbers();',
  '(function(){var p=new URLSearchParams(location.search);var to=p.get("to");if(to){loadContacts().then(function(){openThread(to,p.get("name"));});}})();',
  'setInterval(loadConversations,6000);',
  'setInterval(function(){if(current)loadThread();},5000);',
].join("\n");
