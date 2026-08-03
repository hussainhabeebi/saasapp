/* ── CHATS TAB (extracted from dashboard.html) ──
   Loaded as a plain classic <script> (not a module) right where this code used to sit inline, so
   it shares dashboard.html's global scope exactly as before — this is a file-organization change
   only, not a behavior change. Depends on globals defined in dashboard.html: $id, esc, timeAgo,
   maskPhone, allLeads, clientId, myEmail, sessionToken, CONFIG, ncAuthHeaders, ncPatch,
   freshConvHistory, leadConvId, openDetail, updateChatBadge's DOM targets (dnChatBadge/
   bnChatBadge). connectLiveUpdates/onLiveMessageEvent/disconnectLiveUpdates stayed in
   dashboard.html — they're wired into core app lifecycle (showApp/hLogout) and touch both Home and
   Chats, not Chats-only, so moving them here would need a lifecycle bridge for no real benefit. */
let _chatSearchTimer=null, _chatLeadId=null, CHAT_FILTER='all', CHAT_CHANNEL='whatsapp';
// All leads are already in memory (loadAll fetches up to 2000 in one shot — every other page
// depends on allLeads being the complete set, so that fetch itself isn't paginated here). This is
// DOM-level pagination instead: chatConvoLeads on a busy account can still be a few hundred rows,
// re-rendered into the DOM on every keystroke in search — capping how many contact rows actually
// render at once is the real, cheap-to-fix cost. Reset to CHAT_PAGE_SIZE at each "fresh view"
// entry point (search/filter/channel/tab-open); chatLoadMore() is the only thing that grows it.
const CHAT_PAGE_SIZE=40;
let _chatRenderLimit=CHAT_PAGE_SIZE;

/* ── Unread tracking ──
   No backend concept of "read" exists (ConvHistory/LastMsgAt are the only per-lead signals this
   CRM has) — a localStorage map of leadId → ISO timestamp last opened is enough to answer "has
   this lead had any new activity since I looked", the same thing LastMsgAt vs that stored time
   already reduces to. Scoped per clientId, same as every other lv_* localStorage key (see
   _CACHE_KEY), so switching accounts on one browser can't leak/misattribute another client's
   read state. */
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
  if(!lead.LastMsgAt) return false;
  const readAt=chatGetReadMap()[lead.Id];
  return !readAt || new Date(lead.LastMsgAt)>new Date(readAt);
}
// Both channels, regardless of which one CHAT_CHANNEL currently has selected — this feeds the
// nav badges (visible from any tab), not the Chats tab's own contact list.
function chatAllConvoLeads(){
  return allLeads.filter(l=>l.ConvHistory&&l.ConvHistory!=='[]');
}
function updateChatBadge(){
  const count=chatAllConvoLeads().filter(chatIsUnread).length;
  const dnBadge=$id('dnChatBadge'), bnBadge=$id('bnChatBadge');
  if(dnBadge){ dnBadge.style.display=count?'inline-block':'none'; dnBadge.textContent=count>99?'99+':count; }
  if(bnBadge){ bnBadge.style.display=count?'block':'none'; }
}

function openChatsTab(){
  _chatLeadId=null;
  $id('chatSearch').value='';
  CHAT_FILTER='all';
  CHAT_CHANNEL='whatsapp';
  _chatRenderLimit=CHAT_PAGE_SIZE;
  $id('chatChannelWa').classList.add('active');
  $id('chatChannelIg').classList.remove('active');
  renderChatEmpty();
  renderChatContacts();
}

function setChatFilter(f){ CHAT_FILTER=f; _chatRenderLimit=CHAT_PAGE_SIZE; renderChatContacts(); }

// Switches which Channel chatConvoLeads() filters for — Instagram DM leads live in this exact
// same table/ConvHistory shape (see SETUP.md "Instagram DM module"), so this is the only change
// needed to give Instagram its own view of the same Chats page.
function setChatChannel(ch){
  CHAT_CHANNEL=ch;
  $id('chatChannelWa').classList.toggle('active', ch==='whatsapp');
  $id('chatChannelIg').classList.toggle('active', ch==='instagram');
  _chatLeadId=null;
  _chatRenderLimit=CHAT_PAGE_SIZE;
  renderChatEmpty();
  renderChatContacts();
}

// Base list shared by both the filter-row counts and the actual rendered rows, so a count never
// drifts out of sync with what tapping that chip actually shows — only the search box (applied
// separately below) can make the two differ, and that's deliberate: counts reflect the filter
// tabs only, search narrows whichever tab is currently active.
function chatConvoLeads(){
  return allLeads.filter(l=>l.ConvHistory&&l.ConvHistory!=='[]'&&(l.Channel||'whatsapp')===CHAT_CHANNEL);
}

function renderChatContacts(){
  const q=($id('chatSearch').value||'').trim().toLowerCase();
  const list=$id('chatContactList');
  const base=chatConvoLeads();

  const counts={
    all:base.length,
    needsyou:base.filter(l=>l.Handover==='Yes').length,
    hot:base.filter(l=>l.Score==='Hot').length,
    mine:myEmail?base.filter(l=>l.Owner===myEmail).length:0
  };
  renderChatFilterRow(counts);

  let leads=base.filter(l=>{
    if(CHAT_FILTER==='needsyou' && l.Handover!=='Yes') return false;
    if(CHAT_FILTER==='hot' && l.Score!=='Hot') return false;
    if(CHAT_FILTER==='mine' && l.Owner!==myEmail) return false;
    if(q){
      const nm=(l.Name||'').toLowerCase().includes(q);
      const ph=(l.Phone||'').includes(q);
      let msgMatch=false;
      try{msgMatch=JSON.parse(l.ConvHistory||'[]').some(m=>(m.content||'').toLowerCase().includes(q));}catch(e){}
      return nm||ph||msgMatch;
    }
    return true;
  }).sort((a,b)=>(b.LastMsgAt||b.Date||'').localeCompare(a.LastMsgAt||a.Date||''));

  if(!leads.length){
    const emptyMsg=q?'No matches found':(CHAT_FILTER==='all'?'No conversations yet':'Nothing here right now');
    list.innerHTML=`<div class="chat-empty"><div class="chat-empty-icon">${q?'🔍':'💬'}</div><div>${emptyMsg}</div></div>`;
    $id('chatLoadMore').style.display='none';
    return;
  }

  const totalMatched=leads.length;
  leads=leads.slice(0, _chatRenderLimit);
  // Reassigning innerHTML resets scroll to the top — fine for a fresh search/filter, but jarring
  // right after clicking "Load more" at the bottom, so that specific case restores it.
  const prevScrollTop=list.scrollTop;

  list.innerHTML=leads.map(l=>{
    let lastMsg='', lastFromUs=false;
    try{
      const h=JSON.parse(l.ConvHistory||'[]');
      const last=h[h.length-1];
      if(last){ lastMsg=(last.content||'').slice(0,50); lastFromUs=last.role==='assistant'||last.role==='bot'; }
    }catch(e){}
    const initial=(l.Name||l.Phone||'?')[0].toUpperCase();
    const when=timeAgo(l.LastMsgAt||l.Date||'');
    const scoreDot=l.Score==='Hot'?'🔴 ':l.Score==='Warm'?'🟡 ':'';
    // WhatsApp's list shows the last message as the subtitle, not a phone number — but this
    // CRM leans on phone to identify leads with no name yet, so fall back to it only then.
    const preview=l.Name?lastMsg:(maskPhone(l.Phone)+(lastMsg?' — '+lastMsg:''));
    // Small red dot on the avatar — same "waiting on a human" signal Human Deals uses (Handover
    // field), so a chat that needs you stands out even while browsing the "All" tab, not just
    // inside the "Needs You" filter.
    const needsYou=l.Handover==='Yes'?'<span class="cc-needs-you" title="Waiting on a human"></span>':'';
    const unread=chatIsUnread(l);
    return `<div class="chat-contact-row${_chatLeadId===l.Id?' active':''}" id="ccRow${l.Id}" onclick="chatSelectLead(${l.Id})">
      <div class="cc-avatar">${initial}${needsYou}</div>
      <div class="cc-info">
        <div class="cc-row-top">
          <div class="cc-name"${unread?' style="font-weight:700"':''}>${scoreDot}${esc(l.Name||'Unknown')}</div>
          <div class="cc-time">${esc(when)}</div>
        </div>
        <div class="cc-row-bottom">
          ${lastFromUs?'<span class="cc-check">✓✓</span>':''}
          <div class="cc-preview"${unread?' style="color:#111b21;font-weight:600"':''}>${esc(preview)}</div>
          ${unread?'<span class="cc-unread-dot" title="Unread"></span>':''}
        </div>
      </div>
    </div>`;
  }).join('');
  list.scrollTop=prevScrollTop;
  const loadMoreBtn=$id('chatLoadMore');
  const remaining=totalMatched-leads.length;
  if(remaining>0){
    loadMoreBtn.style.display='block';
    loadMoreBtn.textContent=`Load more contacts ↓ (${remaining} more)`;
  }else{
    loadMoreBtn.style.display='none';
  }
  updateChatBadge();
}

function renderChatFilterRow(counts){
  const tabs=[['all','All'],['needsyou','Needs You'],['hot','🔴 Hot'],['mine','Mine']];
  $id('chatFilterRow').innerHTML=tabs.map(([key,label])=>
    `<button class="chat-filter-btn${CHAT_FILTER===key?' active':''}" onclick="setChatFilter('${key}')">${label}<span class="cnt">${counts[key]}</span></button>`
  ).join('');
}

function chatSearchDebounce(){
  clearTimeout(_chatSearchTimer);
  _chatRenderLimit=CHAT_PAGE_SIZE;
  _chatSearchTimer=setTimeout(()=>renderChatContacts(),300);
}

function chatLoadMore(){
  _chatRenderLimit+=CHAT_PAGE_SIZE;
  renderChatContacts();
}

function chatSelectLead(leadId){
  document.querySelectorAll('.chat-contact-row').forEach(r=>r.classList.remove('active'));
  const row=$id('ccRow'+leadId);
  if(row) row.classList.add('active');
  _chatLeadId=leadId;
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  // Marks read on open, not on send/close — matches every real chat app (opening the thread is
  // what clears the badge, whether or not the rep actually replies).
  if(chatIsUnread(lead)){
    chatMarkRead(leadId);
    if(row) row.querySelector('.cc-unread-dot')?.remove();
    updateChatBadge();
  }

  let history=[];
  try{history=JSON.parse(lead.ConvHistory||'[]');}catch(e){}

  document.querySelector('.chats-layout')?.classList.add('chat-open');
  const main=$id('chatMain');
  main.innerHTML=`
    <div class="chat-main-hd">
      <button class="chat-back-btn" onclick="chatBackToList()" title="Back to chats" style="margin-right:2px">←</button>
      <div class="cc-avatar lg">${(lead.Name||'?')[0].toUpperCase()}</div>
      <div style="flex:1;min-width:0">
        <div class="chat-main-name">${esc(lead.Name||'Unknown')}</div>
        <div class="chat-main-phone">${lead.Channel==='instagram'?'📷 Instagram DM':esc(lead.Phone||'')} · ${esc(lead.Stage||'new')}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="openDetail(${lead.Id})">View Lead →</button>
    </div>
    <div class="chat-messages" id="chatMsgBox" style="flex:1;overflow-y:auto;padding:16px 6%">
      ${history.length?history.map((m,i)=>{
        const isOut=m.role==='assistant'||m.role==='bot';
        // Tail only on the first bubble of a consecutive run from the same side — matches
        // how WhatsApp groups a burst of messages from one sender under a single tail.
        const prevOut=i>0&&(history[i-1].role==='assistant'||history[i-1].role==='bot');
        const firstInGroup=i===0||prevOut!==isOut;
        const side=isOut?'out':'in';
        return `<div class="chat-bubble-row ${side}">
          <div class="chat-bubble ${side}${firstInGroup?' tail-'+side:''}">${esc(m.content||'').replace(/\n/g,'<br>')}<span class="bubble-meta">${m.ts?`<span class="bubble-time">${new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>`:''}${isOut?'<span class="bubble-check">✓✓</span>':''}</span>
          </div>
        </div>`;
      }).join(''):'<div style="color:#667781;font-size:13px;text-align:center;padding:20px">No conversation yet</div>'}
    </div>
    <div class="chat-input-bar">
      <textarea id="chatReplyBox" class="chat-input-box" rows="1" placeholder="Type a message"></textarea>
      <button class="chat-send-btn" onclick="chatSendFromTab(${lead.Id})" title="Send">➤</button>
    </div>
    <div id="chatReplyMsg" class="chat-send-status"></div>`;
  // scroll to bottom
  setTimeout(()=>{const b=$id('chatMsgBox');if(b)b.scrollTop=b.scrollHeight;},50);
}

async function chatSendFromTab(leadId){
  const input=$id('chatReplyBox');
  const msg=$id('chatReplyMsg');
  const text=(input?.value||'').trim();
  if(!text||!leadId) return;
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead){return;}
  const isInstagram=lead.Channel==='instagram';
  const convId=isInstagram?null:leadConvId(lead);
  // WhatsApp requires a real Chatwoot conversation — silently writing to ConvHistory only and
  // reporting "Sent" when there's nowhere to actually deliver it is worse than an error.
  // Instagram has no Chatwoot conversation at all (that's the whole point of that module) — its
  // check further down is against the lead's IgId instead.
  if(!isInstagram && !convId){msg.textContent='No Chatwoot conversation linked to this lead — reply cannot reach WhatsApp.';msg.className='chat-send-status err';return;}
  msg.textContent='Sending…'; msg.className='chat-send-status';
  let delivered=false;
  try{
    // Sent via the Worker proxy (cloudflare-worker/worker.js), which holds the Chatwoot/Instagram
    // token server-side and makes the actual send itself.
    const url=isInstagram?`${CONFIG.WORKER_BASE}/instagram/send`:`${CONFIG.WORKER_BASE}/chat/send`;
    const payload=isInstagram?{lead_id:lead.Id,text}:{conv_id:convId,text};
    const r=await fetch(url,{
      method:'POST',
      headers:ncAuthHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify(payload)
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||'HTTP '+r.status);
    delivered=true;
  }catch(e){
    msg.textContent=`Failed — message did not reach ${isInstagram?'Instagram':'Chatwoot'}: `+e.message; msg.className='chat-send-status err';
    return;
  }
  if(!delivered){
    msg.textContent=`Failed — message did not reach ${isInstagram?'Instagram':'Chatwoot'}.`; msg.className='chat-send-status err';
    return;
  }
  const hist=await freshConvHistory(lead);
  hist.push({role:'assistant',content:text,ts:new Date().toISOString()});
  try{
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:lead.Id,ConvHistory:JSON.stringify(hist)});
  }catch(e){/* best-effort — the WhatsApp message already went out */}
  lead.ConvHistory=JSON.stringify(hist);
  input.value='';
  msg.textContent='Sent ✓'; msg.className='chat-send-status';
  chatSelectLead(leadId);
  setTimeout(()=>{if(msg)msg.textContent='';},2500);
}

function renderChatEmpty(){
  document.querySelector('.chats-layout')?.classList.remove('chat-open');
  $id('chatMain').innerHTML=`<div class="chat-empty" style="flex:1;display:flex">
    <div class="chat-empty-icon">💬</div>
    <div>Select a contact to view their conversation</div>
  </div>`;
}

// Mobile-only "back to contact list" — the chat-open class flip is invisible on desktop (both
// panes are always shown there, see the max-width:767px rule), so this is purely a phone-width
// affordance. Leaves _chatLeadId/the rendered thread alone so reopening the same contact doesn't
// need a re-fetch.
function chatBackToList(){
  document.querySelector('.chats-layout')?.classList.remove('chat-open');
}
