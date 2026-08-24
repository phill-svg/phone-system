// Shared client-side (inline <script>) phone-number helpers, used by both the Phone and Messages
// admin pages. Written as a plain JS-source string (not real TS/a module) because these pages ship
// their client code as inline <script> text rather than a bundled file. Must stay in lock-step with
// the server-side algorithms: normalizePhoneJS mirrors db/contacts.ts normalizePhone(), formatAu
// mirrors html/formatPhone.ts formatAuNumber().
export const CLIENT_PHONE_JS =
  'function normalizePhoneJS(raw){ if(!raw) return ""; var hasPlus=String(raw).trim().charAt(0)==="+"; var d=String(raw).replace(/\\D/g,""); if(!d) return ""; if(hasPlus) return d; if(d.charAt(0)==="0") return "61"+d.slice(1); return d; }\n' +
  'function formatAu(raw){ var s=String(raw==null?"":raw); var d=s.replace(/[^\\d+]/g,""); var n; if(d.charAt(0)==="+"){ n=d.indexOf("+61")===0?"0"+d.slice(3):d; } else if(d.indexOf("61")===0&&d.length>9){ n="0"+d.slice(2); } else { n=d; } if(/^04\\d{8}$/.test(n)) return n.slice(0,4)+" "+n.slice(4,7)+" "+n.slice(7); if(/^0[2378]\\d{8}$/.test(n)) return n.slice(0,2)+" "+n.slice(2,6)+" "+n.slice(6); if(/^13\\d{4}$/.test(n)) return n.slice(0,2)+" "+n.slice(2); if(/^1[38]00\\d{6}$/.test(n)) return n.slice(0,4)+" "+n.slice(4,7)+" "+n.slice(7); return n||s; }';
