import { renderLayout } from "../layout";
import { CLIENT_PHONE_JS } from "../clientPhoneJs";

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
    .conv-bottom { display: flex; align-items: center; gap: 0.4rem; min-width: 0; margin-top: 0.1rem; }
    .conv-last { flex: 1; color: var(--admin-dim); font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .conv-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--admin-brand); align-self: center; flex-shrink: 0; }
    /* Shown only while some Facebook sender is still nameless — the Graph API lookup runs once per
       inbound message, so a spell of failed lookups leaves those threads as "Facebook user". */
    .fb-names { display: none; align-items: center; gap: 0.5rem; padding: 0.55rem 0.8rem; border-bottom: 1px solid var(--admin-border); font-size: 0.76rem; color: var(--admin-dim); }
    .fb-names button { font-size: 0.74rem; padding: 0.25rem 0.55rem; white-space: nowrap; }
    .fb-names-msg { flex: 1; min-width: 0; }
    .msg-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .msg-pane-head { padding: 0.8rem 1.1rem; border-bottom: 1px solid var(--admin-border); display: flex; align-items: center; gap: 0.6rem; min-height: 24px; }
    .msg-pane-head input { flex: 1; max-width: 260px; }
    /* Channel tag: every conversation says whether it is SMS or Facebook Messenger, in the list and
       above the open thread, because the two arrive in the same inbox and read identically. */
    .chan { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; padding: 0.1rem 0.34rem; border-radius: 5px; flex-shrink: 0; white-space: nowrap; }
    .chan-sms { background: rgba(255,255,255,0.05); color: var(--admin-dim); border: 1px solid var(--admin-border); }
    .chan-fb { background: rgba(8,102,255,0.18); color: #7ab0ff; border: 1px solid rgba(8,102,255,0.5); }
    .msg-pane-head .chan { font-size: 0.66rem; padding: 0.14rem 0.4rem; }
    .fb-name-btn { font-size: 0.7rem; padding: 0.15rem 0.5rem; }
    .msg-scroll { flex: 1; overflow-y: auto; padding: 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .bubble-row { display: flex; }
    .bubble-row.out { justify-content: flex-end; }
    .bubble { max-width: 68%; padding: 0.5rem 0.75rem; border-radius: 14px; font-size: 0.9rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
    .bubble.in { background: var(--admin-surface); border: 1px solid var(--admin-border); }
    .bubble.in.fb { border-color: rgba(8,102,255,0.5); }
    .bubble.out { background: var(--admin-brand); color: #fff; }
    .msg-status-fail { font-size: 0.72rem; color: #ff6b6b; padding: 0.05rem 0.3rem 0; }
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
        '<div id="fbNames" class="fb-names">' +
          '<span class="fb-names-msg" id="fbNamesMsg">Some Facebook senders have no name yet.</span>' +
          '<button id="fbNamesBtn" title="Ask Facebook for their names">Get names</button>' +
        '</div>' +
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
  // Shared with html/pages/phone.ts (see ../clientPhoneJs) so the two inline-JS copies can't drift.
  CLIENT_PHONE_JS,
  'function resolveName(number){ var c=contactsByNorm[normalizePhoneJS(number)]; return c?c.name:null; }',
  // Messenger peers are stored as "messenger:<psid>", never a phone number — that prefix is the only
  // thing separating a Facebook conversation from an SMS one anywhere in this UI.
  'function isMessenger(number){ return String(number==null?"":number).indexOf("messenger:")===0; }',
  'function avatarText(c){ return (isMessenger(c.number)&&!c.name)?"FB":initials(label(c)); }',
  'function chanChip(number){ return isMessenger(number)?"<span class=\\"chan chan-fb\\">Messenger</span>":"<span class=\\"chan chan-sms\\">SMS</span>"; }',
  'function loadContacts(){ return api("/api/contacts").then(function(list){ contactsByNorm={}; (list||[]).forEach(function(c){ if(c&&c.phone_normalized) contactsByNorm[c.phone_normalized]=c; }); }).catch(function(){}); }',
  'var smsNumbers=[];',
  'function loadNumbers(){ return api("/api/numbers").then(function(nums){ smsNumbers=(nums||[]).filter(function(n){return n.sms_enabled;}); }).catch(function(){}); }',
  // "From" row above the composer: 2+ SMS numbers => a dropdown; exactly 1 => a static line; 0 => hidden.
  'function renderSmsFromRow(){ var row=document.getElementById("smsFromRow"); if(!row) return; row.innerHTML=""; if(isMessenger(current)){ row.style.display="flex"; var fb=document.createElement("span"); fb.textContent="Replying via Facebook Messenger"; row.appendChild(fb); return; } if(smsNumbers.length===0){ row.style.display="none"; return; } row.style.display="flex"; if(smsNumbers.length===1){ var s=document.createElement("span"); s.textContent="From "+smsNumbers[0].label+" · "+formatAu(smsNumbers[0].e164); row.appendChild(s); } else { var lbl=document.createElement("span"); lbl.textContent="From"; var sel=document.createElement("select"); sel.id="smsFromSelect"; smsNumbers.forEach(function(n){ var o=document.createElement("option"); o.value=n.e164; o.textContent=n.label+" · "+formatAu(n.e164); if(n.is_default_sms) o.selected=true; sel.appendChild(o); }); row.appendChild(lbl); row.appendChild(sel); } }',
  'function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}',
  'function initials(s){s=(s||"").trim();if(!s)return "?";var p=s.replace(/[^0-9a-zA-Z ]/g,"").split(" ").filter(Boolean);if(p.length===0)return s.slice(-2);if(p.length===1)return p[0].slice(0,2).toUpperCase();return (p[0][0]+p[p.length-1][0]).toUpperCase();}',
  'function when(ms){var d=new Date(ms),n=new Date();if(d.toDateString()===n.toDateString())return d.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"});return d.toLocaleDateString("en-AU",{day:"2-digit",month:"2-digit"});}',
  // On failure, reads the JSON body for the backend's actual {error, detail} instead of discarding
  // it -- previously every failed send/save just threw the bare HTTP status code, so staff only ever
  // saw a generic "Could not..." alert with no clue why (e.g. Messenger send rejected by Facebook).
  'function api(path,opts){return fetch(path,Object.assign({credentials:"same-origin",headers:{"Content-Type":"application/json"}},opts||{})).then(function(r){if(!r.ok){return r.json().catch(function(){return null;}).then(function(body){var err=new Error((body&&body.error)||("request failed ("+r.status+")"));err.detail=body&&body.detail;throw err;});}return r.status===204?null:r.json();});}',
  // A Messenger peer has no phone number to format or match against contacts: it is either the name
  // Facebook gave us or nothing, so never run a PSID through the phone helpers.
  'function label(c){ if(isMessenger(c.number)) return c.name||"Facebook user"; return c.name||resolveName(c.number)||formatAu(c.number); }',
  'function loadConversations(){return api("/api/messages").then(function(list){list=list||[];renderConversations(list);renderFbNamesBar(list);}).catch(function(){});}',
  'function renderFbNamesBar(list){ var bar=document.getElementById("fbNames"); if(!bar) return; var missing=0; for(var i=0;i<list.length;i++){ if(isMessenger(list[i].number)&&!list[i].name) missing++; } bar.style.display=missing?"flex":"none"; if(missing) document.getElementById("fbNamesMsg").textContent=(missing===1?"1 Facebook sender has no name yet.":missing+" Facebook senders have no name yet.")+" Open one to type a name in yourself."; }',
  // Retries the Graph API lookup for those senders. Says what Facebook objected to when it fails
  // -- an expired Page token is the usual reason names stop appearing, and it is invisible otherwise.
  // Typed-in fallback for when Facebook won't tell us the name. Writes to the same cache the Graph
  // lookup fills, so the list, the thread header and the push notification all pick it up.
  'function addFbNameButton(number,named){ var head=document.getElementById("paneHead"); if(!head) return; var b=document.createElement("button"); b.className="fb-name-btn"; b.id="fbNameBtn"; b.textContent=named?"Rename":"Add name"; b.title="Save a name for this Facebook contact"; b.addEventListener("click",function(){ nameFbPerson(number); }); head.appendChild(b); }',
  'function nameFbPerson(number){ var el=document.querySelector("#paneHead strong"); var cur=el?el.textContent:""; if(cur==="Facebook user") cur=""; var name=prompt("Name for this Facebook contact:",cur); if(name===null) return; name=name.trim(); if(!name) return; api("/api/facebook/name",{method:"PUT",body:JSON.stringify({psid:number,name:name})}).then(function(){ loadConversations(); openThread(number,name); }).catch(function(){ alert("Could not save that name."); }); }',
  'function fetchFbNames(){ var btn=document.getElementById("fbNamesBtn"); var msg=document.getElementById("fbNamesMsg"); btn.disabled=true; msg.textContent="Asking Facebook..."; api("/api/facebook/resolve-names",{method:"POST"}).then(function(r){ r=r||{}; var got=(r.resolved||[]).length; var bad=(r.failed||[]); if(got) { loadContacts().then(loadConversations); } if(bad.length){ msg.textContent="Facebook could not name "+bad.length+" sender"+(bad.length===1?"":"s")+": "+bad[0].error; } else if(!got){ msg.textContent="No names to fetch."; } }).catch(function(){ msg.textContent="The name lookup failed. Check that FB_PAGE_ACCESS_TOKEN is set."; }).then(function(){ btn.disabled=false; }); }',
  'function renderConversations(list){var el=document.getElementById("convList");if(list.length===0){el.innerHTML="<div class=\\"msg-empty\\" style=\\"padding:2rem 1rem\\">No conversations yet.</div>";return;}var html="";for(var i=0;i<list.length;i++){var c=list[i];var active=c.number===current?" active":"";html+="<div class=\\"conv"+active+"\\" data-num=\\""+esc(c.number)+"\\">"+"<div class=\\"conv-avatar\\">"+esc(avatarText(c))+"</div>"+"<div class=\\"conv-main\\">"+"<div class=\\"conv-top\\"><span class=\\"conv-name\\">"+esc(label(c))+"</span><span class=\\"conv-time\\">"+esc(when(c.last_ts))+"</span></div>"+"<div class=\\"conv-bottom\\">"+chanChip(c.number)+"<span class=\\"conv-last\\">"+esc(c.last_body)+"</span></div>"+"</div>"+(c.unread>0?"<span class=\\"conv-dot\\"></span>":"")+"</div>";}el.innerHTML=html;var nodes=el.querySelectorAll(".conv");for(var j=0;j<nodes.length;j++){nodes[j].addEventListener("click",function(){openThread(this.getAttribute("data-num"),this.querySelector(".conv-name").textContent);});}}',
  'function openThread(number,name){current=number;document.getElementById("composer").style.display="flex";renderSmsFromRow();var ta=document.getElementById("text");if(ta)ta.placeholder=isMessenger(number)?"Reply on Messenger":"Text message";var head=document.getElementById("paneHead");var c=isMessenger(number)?null:contactsByNorm[normalizePhoneJS(number)];var disp=name||(isMessenger(number)?"Facebook user":(resolveName(number)||formatAu(number)));if(c){head.innerHTML="<span class=\\"pane-head-name\\" id=\\"paneHeadName\\" title=\\"View contact\\"><strong>"+esc(disp)+"</strong></span>"+chanChip(number);var el=document.getElementById("paneHeadName");if(el)el.addEventListener("click",function(){showContactPreview(c,number);});}else{head.innerHTML="<strong>"+esc(disp)+"</strong>"+chanChip(number);}if(isMessenger(number))addFbNameButton(number,disp!=="Facebook user");loadThread();loadConversations();}',
  'function showContactPreview(c,number){document.getElementById("cmAvatar").textContent=initials(c.name||c.phone||number);document.getElementById("cmName").textContent=c.name||formatAu(c.phone||number);var comp=document.getElementById("cmCompany");comp.textContent=c.company||"";comp.style.display=c.company?"block":"none";document.getElementById("cmNumber").textContent=formatAu(c.phone||number);document.getElementById("cmCall").onclick=function(){location.href="/admin/phone?dial="+encodeURIComponent(c.phone||number);};document.getElementById("contactModal").style.display="flex";}',
  'function hideContactPreview(){document.getElementById("contactModal").style.display="none";}',
  'function loadThread(){if(!current)return;api("/api/messages/"+encodeURIComponent(current)).then(function(msgs){renderThread(msgs||[]);}).catch(function(){});}',
  // A Twilio status callback (see /webhooks/twilio/sms-status) can flip an outbound message's status
  // to failed/undelivered well after the initial "sent" -- most commonly a Messenger reply Facebook
  // rejected for being outside the 24-hour window. Surface that instead of showing it as sent forever.
  'function isFailedStatus(s){ return s==="failed"||s==="undelivered"; }',
  'function renderThread(msgs){var el=document.getElementById("scroll");if(msgs.length===0){el.innerHTML="<div class=\\"msg-empty\\">No messages yet. Send the first one below.</div>";return;}var html="";for(var i=0;i<msgs.length;i++){var m=msgs[i];var out=m.direction==="outbound";var inCls=isMessenger(current)?"in fb":"in";var failed=out&&isFailedStatus(m.status);html+="<div class=\\"bubble-row "+(out?"out":"in")+"\\"><div class=\\"bubble "+(out?"out":inCls)+"\\">"+esc(m.body)+"</div></div>";if(failed){var detail=m.error_message||(m.error_code?"Error "+m.error_code:null);html+="<div class=\\"bubble-row out\\"><div class=\\"msg-status-fail\\">Not delivered"+(detail?" -- "+esc(detail):"")+"</div></div>";}}el.innerHTML=html;el.scrollTop=el.scrollHeight;}',
  'function send(){var ta=document.getElementById("text");var body=ta.value.trim();if(!body||!current)return;var btn=document.getElementById("sendBtn");btn.disabled=true;var fs=document.getElementById("smsFromSelect");var payload={to:current,body:body};if(fs&&fs.value)payload.from=fs.value;api("/api/messages",{method:"POST",body:JSON.stringify(payload)}).then(function(){ta.value="";loadThread();loadConversations();}).catch(function(err){alert(err&&err.message?err.message:"Could not send the message.");}).then(function(){btn.disabled=false;});}',
  'function newMessage(){var num=prompt("Send to (phone number):");if(!num)return;num=num.trim();if(!num)return;current=num;document.getElementById("composer").style.display="flex";renderSmsFromRow();document.getElementById("text").placeholder="Text message";document.getElementById("paneHead").innerHTML="<strong>"+esc(resolveName(num)||formatAu(num))+"</strong>"+chanChip(num);document.getElementById("scroll").innerHTML="<div class=\\"msg-empty\\">New message to "+esc(resolveName(num)||formatAu(num))+"</div>";document.getElementById("text").focus();}',
  'document.getElementById("cmClose").addEventListener("click",hideContactPreview);',
  'document.getElementById("contactModal").addEventListener("click",function(e){ if(e.target.id==="contactModal") hideContactPreview(); });',
  'document.addEventListener("keydown",function(e){ if(e.key==="Escape") hideContactPreview(); });',
  'document.getElementById("sendBtn").addEventListener("click",send);',
  'document.getElementById("newBtn").addEventListener("click",newMessage);',
  'document.getElementById("fbNamesBtn").addEventListener("click",fetchFbNames);',
  'document.getElementById("text").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});',
  'loadContacts().then(loadConversations);',
  'loadNumbers();',
  '(function(){var p=new URLSearchParams(location.search);var to=p.get("to");if(to){loadContacts().then(function(){openThread(to,p.get("name"));});}})();',
  'setInterval(loadConversations,6000);',
  'setInterval(function(){if(current)loadThread();},5000);',
].join("\n");
