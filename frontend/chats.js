/* Leadvyne Chats dashboard bridge.
   Chats is now a first-class standalone workspace in frontend/chats.html, matching Projects.
   This small bridge intentionally keeps only dashboard-level concerns: unread badges and the
   navigation entry point. The full conversation UI/data/send logic lives in chats.html. */
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

function openChatsTab(){
  const qs=new URLSearchParams({
    client:String(clientId||''),
    token:String(sessionToken||'')
  });
  location.href='chats.html?'+qs.toString();
}

// Kept as lightweight compatibility hooks for the dashboard's existing live-notification handler.
// Once navigation starts the standalone page takes over channel/thread selection.
function setChatChannel(ch){ CHAT_CHANNEL=ch||'whatsapp'; }
function chatSelectLead(leadId){ _chatLeadId=leadId||null; }
function renderSeenBy(){ /* presence is rendered by the standalone Chats workspace */ }
function renderChatContacts(){ updateChatBadge(); }
function renderChatEmpty(){ /* legacy embedded view is no longer opened */ }
function chatBackToList(){ /* legacy embedded view is no longer opened */ }
