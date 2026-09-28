/* Leadvyne Chats dashboard bridge.
   The full conversation UI/data/send logic lives in frontend/chats.html, embedded in the
   dashboard's #pageChats as an iframe (no separate tab). This bridge keeps the dashboard-level
   concerns: unread badges, the navigation entry point, and a small postMessage channel —
   dashboard → Chats: {channel, leadId} to jump to a conversation;
   Chats → dashboard: ready / thread (open lead id) / read / openLead / home. */
let _chatLeadId=null;
let CHAT_CHANNEL='whatsapp';

function _chatReadKey(){ return `lv_chat_read_${clientId}`; }
function chatGetReadMap(){
  try{ return JSON.parse(localStorage.getItem(_chatReadKey())||'{}'); }catch(e){ return {}; }
}
function chatMarkRead(leadId){
  const map=chatGetReadMap();
  map[leadId]=new Date().toISOString();
  try{ localStorage.setItem(_chatReadKey(), JSON.stringify(map)); }catch(e){}
}
function chatIsUnread(lead){
  if(!lead?.LastMsgAt) return false;
  const readAt=chatGetReadMap()[lead.Id];
  return !readAt || new Date(lead.LastMsgAt)>new Date(readAt);
}
function chatAllConvoLeads(){
  return (allLeads||[]).filter(l=>l.ConvHistory&&l.ConvHistory!=='[]');
}
function updateChatBadge(){
  const count=chatAllConvoLeads().filter(chatIsUnread).length;
  const dnBadge=$id('dnChatBadge'), bnBadge=$id('bnChatBadge');
  if(dnBadge){ dnBadge.style.display=count?'inline-block':'none'; dnBadge.textContent=count>99?'99+':count; }
  if(bnBadge){ bnBadge.style.display=count?'block':'none'; }
}

let _chatsReady=false, _chatsPending=null;
function _chatsFrame(){ return $id('chatsFrame'); }
function _chatsTargetOrigin(){ return location.protocol==='file:'?'*':location.origin; } // file:// = local tests only
function openChatsTab(){
  const f=_chatsFrame();
  if(!f) return;
  // Loaded once on first visit, then kept alive while you move around the CRM — an open
  // conversation, a half-typed reply or a running recording are all still there when you return.
  if(!f.getAttribute('src')){
    const qs=new URLSearchParams({client:String(clientId||''), token:String(sessionToken||''), embed:'1'});
    f.src='chats.html?'+qs.toString();
  }
  _flushChatsPending();
}
function _flushChatsPending(){
  const f=_chatsFrame();
  if(!_chatsReady||!_chatsPending||!f?.contentWindow) return;
  try{ f.contentWindow.postMessage({source:'lv-dashboard', ..._chatsPending}, _chatsTargetOrigin()); _chatsPending=null; }catch(e){}
}
window.addEventListener('message', e=>{
  const f=_chatsFrame();
  if(!f||e.source!==f.contentWindow||e.data?.source!=='lv-chats') return;
  const d=e.data;
  if(d.type==='ready'){ _chatsReady=true; _flushChatsPending(); }
  else if(d.type==='thread'){ _chatLeadId=d.leadId||null; }
  else if(d.type==='read'){ updateChatBadge(); }
  else if(d.type==='home'){ if(typeof navigate==='function') navigate('home'); }
  else if(d.type==='openLead'){
    const lead=(allLeads||[]).find(l=>String(l.Id)===String(d.leadId));
    if(lead&&typeof openDetail==='function') openDetail(lead.Id);
    else if(typeof showToast==='function') showToast('This lead isn\'t loaded in the CRM yet — try again after it refreshes.');
  }
});

// Kept as lightweight compatibility hooks for the dashboard's existing live-notification handler.
// Both are forwarded to the embedded Chats page (queued until it has loaded).
function setChatChannel(ch){ CHAT_CHANNEL=ch||'whatsapp'; _chatsPending={..._chatsPending, channel:CHAT_CHANNEL}; _flushChatsPending(); }
function chatSelectLead(leadId){ _chatLeadId=leadId||null; if(leadId){ _chatsPending={..._chatsPending, leadId}; _flushChatsPending(); } }
function renderSeenBy(){ /* presence is rendered by the standalone Chats workspace */ }
function renderChatContacts(){ updateChatBadge(); }
function renderChatEmpty(){ /* legacy embedded view is no longer opened */ }
function chatBackToList(){ /* legacy embedded view is no longer opened */ }
