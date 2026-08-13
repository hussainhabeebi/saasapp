/* ── CHATS TAB (extracted from dashboard.html) ──
   Loaded as a plain classic <script> (not a module) right where this code used to sit inline, so
   it shares dashboard.html's global scope exactly as before — this is a file-organization change
   only, not a behavior change. Depends on globals defined in dashboard.html: $id, esc, timeAgo,
   maskPhone, allLeads, clientId, clientRecord, currentLead, myEmail, sessionToken, CONFIG,
   ncAuthHeaders, ncPatch, patchClient, ensureClientField, freshConvHistory, leadConvId, openDetail,
   renderDetailNotes, getTeamMembers, teamMemberOptions, getFlow, navigate, openModal, closeModal,
   showToast, renderChatNotifyBanner, updateChatBadge's DOM targets (dnChatBadge/bnChatBadge), and
   the "seen by" presence globals _liveSocket/_chatPresence/_chatHeartbeatTimer.
   connectLiveUpdates/onLiveMessageEvent/onLiveViewingEvent/disconnectLiveUpdates/notifyNewMessage/
   requestChatNotifyPermission stayed in dashboard.html — they're wired into core app lifecycle
   (showApp/hLogout) and touch both Home and Chats, not Chats-only, so moving them here would need a
   lifecycle bridge for no real benefit. */
let _chatSearchTimer=null, _chatLeadId=null, CHAT_FILTER='all', CHAT_CHANNEL='whatsapp';
// Composer state — reply vs. internal-note mode (chatSetComposerMode) and the "/" saved-reply
// picker's current match list (chatComposerInput/chatComposerKeydown/chatPickSavedReply).
let _chatComposerMode='reply', _chatPickerMatches=[], _chatPickerIndex=0;
// The currently-rendered timeline (chatMergedTimeline's own return value, kept around so
// chatSetReplyTarget/in-thread search can look a bubble back up by index without re-parsing
// ConvHistory), the message currently quoted in the composer's reply-preview bar, and in-thread
// search state (chatToggleSearch/chatInThreadSearchInput/chatSearchNav).
let _chatCurrentTimeline=[], _chatReplyTarget=null;
let _chatSearchOpen=false, _chatSearchMatches=[], _chatSearchIndex=0;
const CHAT_PRESENCE_TTL_MS=45000;
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
  if(typeof renderChatNotifyBanner==='function') renderChatNotifyBanner();
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
  }).sort((a,b)=>{
    // Pinned conversations (chatTogglePin) float to the top regardless of filter/search, same as
    // every real chat app's pin behavior — recency still decides the order within each group.
    const pinDiff=(b.Pinned==='Yes'?1:0)-(a.Pinned==='Yes'?1:0);
    return pinDiff||(b.LastMsgAt||b.Date||'').localeCompare(a.LastMsgAt||a.Date||'');
  });

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
          <div class="cc-name"${unread?' style="font-weight:700"':''}>${l.Pinned==='Yes'?'<span class="cc-pin-badge" title="Pinned">📌</span>':''}${scoreDot}${esc(l.Name||'Unknown')}</div>
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

// Merges ConvHistory (chat messages) and NotesList (internal notes, shared with the Lead Detail
// panel's own Notes tab — same field, same addNote() shape, just also rendered inline here) into
// one chronological timeline. Most engine-generated messages carry no `ts` at all (only
// manually-sent replies/attachments do — see chatSendFromTab/chatAttachFile), so exact
// interleaving isn't always possible; each note is inserted right before the first later-timestamped
// message it precedes, or appended at the end otherwise, which is correct for the overwhelmingly
// common case (a note written live while looking at the current conversation).
function chatMergedTimeline(lead){
  let history=[]; try{history=JSON.parse(lead.ConvHistory||'[]');}catch(e){}
  let notesRaw=[]; try{notesRaw=JSON.parse(lead.NotesList||'[]');}catch(e){}
  const timeline=history.map(m=>({kind:'msg', role:m.role, content:m.content, options:m.options||null, media:m.media||null, tsMs:m.ts?Date.parse(m.ts):NaN}));
  notesRaw.slice().reverse().forEach(n=>{
    const tsMs=n.ts?Date.parse(n.ts):(n.date?Date.parse(n.date):NaN);
    const note={kind:'note', text:n.text, author:n.author||'', tsMs};
    if(isNaN(tsMs)){ timeline.push(note); return; }
    const idx=timeline.findIndex(e=>e.kind==='msg' && !isNaN(e.tsMs) && e.tsMs>tsMs);
    if(idx===-1) timeline.push(note); else timeline.splice(idx,0,note);
  });
  return timeline;
}

function chatSelectLead(leadId){
  document.querySelectorAll('.chat-contact-row').forEach(r=>r.classList.remove('active'));
  const row=$id('ccRow'+leadId);
  if(row) row.classList.add('active');
  _chatLeadId=leadId;
  _chatComposerMode='reply';
  _chatReplyTarget=null;
  _chatSearchOpen=false; _chatSearchMatches=[]; _chatSearchIndex=0;
  closeSavedReplyPicker();
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  // Marks read on open, not on send/close — matches every real chat app (opening the thread is
  // what clears the badge, whether or not the rep actually replies).
  if(chatIsUnread(lead)){
    chatMarkRead(leadId);
    if(row) row.querySelector('.cc-unread-dot')?.remove();
    updateChatBadge();
  }

  const timeline=chatMergedTimeline(lead);
  _chatCurrentTimeline=timeline;

  // Attach/template tools reuse the same Chatwoot-conversation relay (/quote/send) and template
  // modal (openSendTemplateModal) already built for Quotes/Leads — neither has an Instagram-DM
  // equivalent (that channel only has the plain-text /instagram/send path), so the tools are
  // simply not offered there rather than wiring up a send path that doesn't exist server-side.
  const isInstagram=lead.Channel==='instagram';
  const convId=isInstagram?null:leadConvId(lead);
  const canUseTools=!isInstagram&&!!convId;

  // Stage quick-select — same options stageOptionsForBulk() shows in Leads, but with the current
  // stage marked so a rep can move a lead along without leaving the conversation.
  const stageIds=Object.keys(getFlow().stages||{});
  const stageList=stageIds.length?stageIds:[...new Set(allLeads.map(l=>l.Stage).filter(Boolean))];
  const stageOptionsHtml=stageList.map(s=>`<option value="${esc(s)}"${s===(lead.Stage||'')?' selected':''}>${esc(s)}</option>`).join('');

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
      <button class="chat-tool-btn" onclick="chatToggleSearch()" title="Search this conversation">🔍</button>
      <div class="chat-seenby" id="chatSeenBy"></div>
      <select class="chat-assignee-select" id="chatStageSelect" title="Stage" onchange="chatSetStage(${lead.Id}, this.value)">${stageOptionsHtml}</select>
      <select class="chat-assignee-select" id="chatAssigneeSelect" title="Assigned to" onchange="chatSetAssignee(${lead.Id}, this.value)">${teamMemberOptions(lead.Owner||'')}</select>
      <button class="chat-pin-btn${lead.Pinned==='Yes'?' pinned':''}" id="chatPinBtn" onclick="chatTogglePin(${lead.Id})" title="${lead.Pinned==='Yes'?'Unpin conversation':'Pin conversation'}">${lead.Pinned==='Yes'?'📌':'📍'}</button>
      <button class="btn btn-secondary btn-sm" onclick="openDetail(${lead.Id})">View Lead →</button>
    </div>
    <div class="chat-search-bar" id="chatSearchBar" style="display:none">
      <input type="text" id="chatInThreadSearch" placeholder="Search this conversation…" oninput="chatInThreadSearchInput()" onkeydown="if(event.key==='Enter'){event.preventDefault();chatSearchNav(event.shiftKey?-1:1);}">
      <span class="chat-search-count" id="chatSearchCount"></span>
      <button onclick="chatSearchNav(-1)" title="Previous match">↑</button>
      <button onclick="chatSearchNav(1)" title="Next match">↓</button>
      <button onclick="chatToggleSearch()" title="Close search">✕</button>
    </div>
    <div class="chat-messages" id="chatMsgBox" style="flex:1;overflow-y:auto;padding:16px 6%">
      ${timeline.length?timeline.map((m,i)=>{
        if(m.kind==='note'){
          const authorName=m.author?(getTeamMembers().find(tm=>tm.email===m.author)?.name||m.author):'';
          const when=!isNaN(m.tsMs)?new Date(m.tsMs).toLocaleString():'';
          return `<div class="chat-note-row"><div class="chat-note">📝 ${esc(m.text||'').replace(/\n/g,'<br>')}${(authorName||when)?`<div class="chat-note-meta">${esc(authorName)}${authorName&&when?' · ':''}${esc(when)}</div>`:''}</div></div>`;
        }
        const isOut=m.role==='assistant'||m.role==='bot';
        // Tail only on the first bubble of a consecutive run from the same side — matches how
        // WhatsApp groups a burst of messages from one sender under a single tail. A note always
        // breaks a group (it's not a chat bubble at all), same as switching sides would.
        const prev=timeline[i-1];
        const prevOut=prev&&prev.kind==='msg'&&(prev.role==='assistant'||prev.role==='bot');
        const firstInGroup=i===0||!prev||prev.kind==='note'||prevOut!==isOut;
        const side=isOut?'out':'in';
        // Quick-reply options (routing.quickReplies, see engineBuildLeadUpsertBody in worker.js)
        // — stacked full-width rows attached under the message, matching how WhatsApp itself
        // renders the interactive-button message Chatwoot sent for this turn. Display-only here:
        // the real tap target was on the customer's phone, this is just an accurate echo of it.
        const optsHtml=(m.options&&m.options.length)
          ? `<div class="bubble-options">${m.options.map(o=>`<div class="bubble-option-btn">${esc(o.title||o.value||'')}</div>`).join('')}</div>`
          : '';
        // Inline media (routing.media, see worker.js engineBuildLeadUpsertBody) — the actual
        // product/category photo sent this turn, so the bubble shows what the customer really saw
        // instead of reading as a blank/text-only message.
        const mediaHtml=(m.media&&m.media.type==='image'&&m.media.url)
          ? `<img class="bubble-media-img" src="${esc(m.media.url)}" loading="lazy" onclick="window.open('${esc(m.media.url)}','_blank')">`
          : '';
        return `<div class="chat-bubble-row ${side}" id="chatBubbleRow${i}">
          <div class="chat-bubble ${side}${firstInGroup?' tail-'+side:''}${optsHtml?' has-options':''}">${mediaHtml}${esc(m.content||'').replace(/\n/g,'<br>')}<span class="bubble-meta">${!isNaN(m.tsMs)?`<span class="bubble-time">${new Date(m.tsMs).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>`:''}${isOut?'<span class="bubble-check">✓✓</span>':''}</span>${optsHtml}
          </div>
          <button class="bubble-reply-btn" onclick="chatSetReplyTarget(${i})" title="Reply">↩️</button>
        </div>`;
      }).join(''):'<div style="color:#667781;font-size:13px;text-align:center;padding:20px">No conversation yet</div>'}
    </div>
    <div id="chatAttachStatus" class="chat-send-status"></div>
    <div class="chat-reply-preview" id="chatReplyPreview" style="display:none">
      <div class="chat-reply-preview-text" id="chatReplyPreviewText"></div>
      <button onclick="chatClearReplyTarget()" title="Cancel reply">✕</button>
    </div>
    <div class="chat-mode-row" id="chatModeRow">
      <button class="chat-mode-btn active" data-mode="reply" onclick="chatSetComposerMode('reply')">💬 Reply</button>
      <button class="chat-mode-btn" data-mode="note" onclick="chatSetComposerMode('note')">📝 Internal note</button>
    </div>
    <div class="chat-input-bar" id="chatInputBar">
      ${canUseTools?`
      <input type="file" id="chatImgInput" accept="image/*" style="display:none" onchange="chatAttachFile(${lead.Id},this.files[0],'image')">
      <input type="file" id="chatDocInput" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" style="display:none" onchange="chatAttachFile(${lead.Id},this.files[0],'document')">
      <div class="chat-tools" id="chatToolsWrap">
        <button class="chat-tool-btn" onclick="$id('chatImgInput').click()" title="Attach image">🖼️</button>
        <button class="chat-tool-btn" onclick="$id('chatDocInput').click()" title="Attach document">📎</button>
        <button class="chat-tool-btn" onclick="openSendTemplateModal([${lead.Id}])" title="Send WhatsApp template">📣</button>
        <button class="chat-tool-btn" onclick="openSavedRepliesModal()" title="Saved replies">⚡</button>
      </div>`:`<div class="chat-tools" id="chatToolsWrap"><button class="chat-tool-btn" onclick="openSavedRepliesModal()" title="Saved replies">⚡</button></div>`}
      <div style="position:relative;flex:1;min-width:0">
        <div class="saved-reply-picker" id="chatSavedReplyPicker" style="display:none"></div>
        <textarea id="chatReplyBox" class="chat-input-box" rows="1" placeholder="Type a message" oninput="chatComposerInput(${lead.Id})" onkeydown="return chatComposerKeydown(event, ${lead.Id})" onblur="setTimeout(closeSavedReplyPicker,150)"></textarea>
      </div>
      <button class="chat-send-btn" onclick="chatSendFromTab(${lead.Id})" title="Send (Enter) — Shift+Enter for a new line">➤</button>
    </div>
    <div id="chatReplyMsg" class="chat-send-status"></div>`;
  // scroll to bottom
  setTimeout(()=>{const b=$id('chatMsgBox');if(b)b.scrollTop=b.scrollHeight;},50);
  renderSeenBy(lead.Id);
  chatStartPresenceHeartbeat(lead.Id);
}

// "Seen by" — ephemeral presence, not a persisted read receipt (see worker.js ClientUpdatesHub's
// webSocketMessage). A heartbeat every 20s while this lead's thread is open; other connected
// dashboards age an entry out after CHAT_PRESENCE_TTL_MS of silence (chatSelectLead's onmessage
// relay never explicitly says "left", a closed tab just stops heartbeating).
function chatStartPresenceHeartbeat(leadId){
  clearInterval(_chatHeartbeatTimer);
  const ping=()=>{ try{ if(_liveSocket && _liveSocket.readyState===1) _liveSocket.send(JSON.stringify({type:'viewing', lead_id:leadId})); }catch(e){} };
  ping();
  _chatHeartbeatTimer=setInterval(ping,20000);
}
function renderSeenBy(leadId){
  const box=$id('chatSeenBy');
  if(!box) return;
  const map=_chatPresence[leadId]||{};
  const now=Date.now();
  const viewers=Object.entries(map).filter(([email,v])=>email!==myEmail && (now-new Date(v.at).getTime())<CHAT_PRESENCE_TTL_MS).slice(0,4);
  box.innerHTML=viewers.map(([email,v])=>`<span class="seenby-avatar" title="${esc(v.name||email)} is viewing this chat">${esc((v.name||email)[0].toUpperCase())}</span>`).join('');
}

async function chatSetAssignee(leadId, email){
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  const prev=lead.Owner||'';
  lead.Owner=email;
  if(currentLead && currentLead.Id===leadId) currentLead.Owner=email;
  try{
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:leadId,Owner:email});
    showToast(email?`Assigned to ${getTeamMembers().find(m=>m.email===email)?.name||email}`:'Unassigned');
  }catch(e){
    lead.Owner=prev;
    if(currentLead && currentLead.Id===leadId) currentLead.Owner=prev;
    const sel=$id('chatAssigneeSelect'); if(sel) sel.value=prev;
    showToast('Failed to update assignee','err');
  }
}

// Stage quick-select in the chat header — a contextual action so a rep can move a lead along the
// funnel without leaving the conversation to open the full Lead Detail panel. Plain direct write,
// same minimal-side-effect shape as chatSetAssignee just above (no Follow-up-flag reset, no
// analytics event) — a rep consciously picking a stage here is a deliberate override, same as
// picking it from the Lead Detail panel's own stage select already is.
async function chatSetStage(leadId, stage){
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  const prev=lead.Stage||'';
  lead.Stage=stage;
  if(currentLead && currentLead.Id===leadId) currentLead.Stage=stage;
  try{
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:leadId,Stage:stage});
    showToast(`Stage set to ${stage}`);
    const phoneEl=document.querySelector('.chat-main-phone');
    if(phoneEl) phoneEl.textContent=`${lead.Channel==='instagram'?'📷 Instagram DM':(lead.Phone||'')} · ${stage}`;
  }catch(e){
    lead.Stage=prev;
    if(currentLead && currentLead.Id===leadId) currentLead.Stage=prev;
    const sel=$id('chatStageSelect'); if(sel) sel.value=prev;
    showToast('Failed to update stage','err');
  }
}

// Pin/unpin — POST /chats/pin (worker.js handleChatPinLead) rather than a direct NocoDB write like
// chatSetAssignee/chatSetStage, so the `Pinned` column gets self-healed (ensureLeadsColumns) on
// whichever teammate happens to click this first, instead of every write site needing its own
// "does this column exist yet" guard.
async function chatTogglePin(leadId){
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  const next=lead.Pinned!=='Yes';
  const prev=lead.Pinned||'No';
  lead.Pinned=next?'Yes':'No';
  const btn=$id('chatPinBtn');
  if(btn){ btn.classList.toggle('pinned', next); btn.textContent=next?'📌':'📍'; btn.title=next?'Unpin conversation':'Pin conversation'; }
  try{
    const r=await fetch(`${CONFIG.WORKER_BASE}/chat/pin`,{method:'POST',headers:ncAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({lead_id:leadId,pinned:next})});
    if(!r.ok) throw new Error('HTTP '+r.status);
    showToast(next?'Pinned to top':'Unpinned');
    if($id('pageChats') && !$id('pageChats').classList.contains('hidden')) renderChatContacts();
  }catch(e){
    lead.Pinned=prev;
    if(btn){ btn.classList.toggle('pinned', prev==='Yes'); btn.textContent=prev==='Yes'?'📌':'📍'; }
    showToast('Failed to update pin','err');
  }
}

// Quote-reply — a bubble's ↩️ button stores its (already-trimmed) text here; chatSendFromTab
// prefixes the next outgoing message with a short quoted excerpt using WhatsApp's own *bold*
// markdown (rendered as real bold text on the customer's phone) rather than any Chatwoot-specific
// "in-reply-to" metadata, since a plain WhatsApp Cloud API text message has no such field to set —
// this is the same "fake it in the message body" approach every WhatsApp bot integration without
// native context-reply support uses.
function chatSetReplyTarget(i){
  const m=_chatCurrentTimeline[i];
  if(!m||m.kind!=='msg') return;
  const isOut=m.role==='assistant'||m.role==='bot';
  const snippet=(m.content||(m.media?'📷 Photo':'')).replace(/\s+/g,' ').trim().slice(0,80);
  _chatReplyTarget={snippet, isOut};
  const bar=$id('chatReplyPreview'), text=$id('chatReplyPreviewText');
  if(bar){ bar.style.display='flex'; }
  if(text) text.textContent=`Replying to ${isOut?'yourself':'customer'}: "${snippet}${snippet.length>=80?'…':''}"`;
  const box=$id('chatReplyBox'); if(box) box.focus();
}
function chatClearReplyTarget(){
  _chatReplyTarget=null;
  const bar=$id('chatReplyPreview');
  if(bar) bar.style.display='none';
}

// In-thread search — pure client-side filter over the already-rendered timeline (no new endpoint;
// everything's already in ConvHistory/NotesList in the browser). Highlights every matching bubble
// at once (search-hit class) and chatSearchNav scrolls between them one at a time, wrapping around.
function chatToggleSearch(){
  _chatSearchOpen=!_chatSearchOpen;
  const bar=$id('chatSearchBar');
  if(!bar) return;
  bar.style.display=_chatSearchOpen?'flex':'none';
  if(_chatSearchOpen){ $id('chatInThreadSearch')?.focus(); }
  else{ chatClearSearchHighlights(); $id('chatInThreadSearch').value=''; }
}
function chatClearSearchHighlights(){
  document.querySelectorAll('.chat-bubble.search-hit').forEach(el=>el.classList.remove('search-hit'));
  _chatSearchMatches=[]; _chatSearchIndex=0;
  const cnt=$id('chatSearchCount'); if(cnt) cnt.textContent='';
}
function chatInThreadSearchInput(){
  chatClearSearchHighlights();
  const q=($id('chatInThreadSearch')?.value||'').trim().toLowerCase();
  if(!q) return;
  _chatSearchMatches=_chatCurrentTimeline
    .map((m,i)=>({m,i}))
    .filter(({m})=>m.kind==='msg' && (m.content||'').toLowerCase().includes(q))
    .map(({i})=>i);
  _chatSearchMatches.forEach(i=>{
    const row=$id('chatBubbleRow'+i);
    row?.querySelector('.chat-bubble')?.classList.add('search-hit');
  });
  const cnt=$id('chatSearchCount');
  if(cnt) cnt.textContent=_chatSearchMatches.length?`0/${_chatSearchMatches.length}`:'No matches';
  if(_chatSearchMatches.length){ _chatSearchIndex=_chatSearchMatches.length-1; chatSearchNav(1); }
}
function chatSearchNav(dir){
  if(!_chatSearchMatches.length) return;
  _chatSearchIndex=(_chatSearchIndex+dir+_chatSearchMatches.length)%_chatSearchMatches.length;
  const row=$id('chatBubbleRow'+_chatSearchMatches[_chatSearchIndex]);
  row?.scrollIntoView({behavior:'smooth', block:'center'});
  const cnt=$id('chatSearchCount');
  if(cnt) cnt.textContent=`${_chatSearchIndex+1}/${_chatSearchMatches.length}`;
}

// Reply vs. internal-note composer (Front/Intercom's private-note pattern) — a note never reaches
// the customer: chatSendFromTab branches on _chatComposerMode and, in note mode, writes straight
// to NotesList (chatSubmitNote) instead of calling the Chatwoot/Instagram send endpoint, skipping
// the "needs a linked conversation" requirement a real reply has.
function chatSetComposerMode(mode){
  _chatComposerMode=mode;
  document.querySelectorAll('.chat-mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  const bar=$id('chatInputBar'); if(bar) bar.classList.toggle('note-mode', mode==='note');
  const box=$id('chatReplyBox'); if(box) box.placeholder=mode==='note'?'Add a private note — visible to your team only…':'Type a message';
  closeSavedReplyPicker();
}

// Enter sends (or picks the highlighted saved reply while that picker is open); Shift+Enter is a
// normal newline — the keyboard discipline every chat app trains muscle memory around.
function chatComposerKeydown(e, leadId){
  const pickerOpen=_chatPickerMatches.length>0;
  if(pickerOpen){
    if(e.key==='ArrowDown'){ e.preventDefault(); _chatPickerIndex=Math.min(_chatPickerIndex+1,_chatPickerMatches.length-1); renderSavedReplyPicker(); return false; }
    if(e.key==='ArrowUp'){ e.preventDefault(); _chatPickerIndex=Math.max(_chatPickerIndex-1,0); renderSavedReplyPicker(); return false; }
    if(e.key==='Enter'||e.key==='Tab'){ e.preventDefault(); chatPickSavedReply(_chatPickerIndex); return false; }
    if(e.key==='Escape'){ closeSavedReplyPicker(); return false; }
  }
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    chatSendFromTab(leadId);
    return false;
  }
  return true;
}

function chatAutosize(box){
  box.style.height='auto';
  box.style.height=Math.min(box.scrollHeight,100)+'px';
}

// Saved-reply "/" picker — triggered by a "/shortcut" token right before the caret, same slash-
// command convention Slack/Front/Intercom composers use. Reply-mode only (a note doesn't need
// customer-facing canned text as much, and keeping it reply-only avoids the picker firing while
// someone's writing a note that happens to contain a literal "/").
function chatComposerInput(leadId){
  const box=$id('chatReplyBox');
  if(!box) return;
  chatAutosize(box);
  if(_chatComposerMode!=='reply'){ closeSavedReplyPicker(); return; }
  const caret=box.selectionStart;
  const m=box.value.slice(0,caret).match(/(^|\s)\/([a-zA-Z0-9_-]*)$/);
  if(!m){ closeSavedReplyPicker(); return; }
  const query=m[2].toLowerCase();
  let replies=[]; try{replies=JSON.parse(clientRecord?.saved_replies||'[]');}catch(e){}
  _chatPickerMatches=replies.filter(r=>(r.shortcut||'').toLowerCase().includes(query)||(r.text||'').toLowerCase().includes(query)).slice(0,6);
  _chatPickerIndex=0;
  if(!_chatPickerMatches.length){ closeSavedReplyPicker(); return; }
  const picker=$id('chatSavedReplyPicker');
  if(picker) picker.style.display='block';
  renderSavedReplyPicker();
}
function renderSavedReplyPicker(){
  const picker=$id('chatSavedReplyPicker');
  if(!picker) return;
  picker.innerHTML=_chatPickerMatches.map((r,i)=>
    `<div class="saved-reply-opt${i===_chatPickerIndex?' active':''}" onmousedown="event.preventDefault();chatPickSavedReply(${i})"><span class="sr-shortcut">/${esc(r.shortcut||'')}</span><span class="sr-text">${esc((r.text||'').slice(0,60))}</span></div>`
  ).join('');
}
function closeSavedReplyPicker(){
  const picker=$id('chatSavedReplyPicker');
  if(picker) picker.style.display='none';
  _chatPickerMatches=[]; _chatPickerIndex=0;
}
function chatPickSavedReply(i){
  const r=_chatPickerMatches[i];
  const box=$id('chatReplyBox');
  if(!r||!box) return;
  const caret=box.selectionStart;
  const val=box.value;
  const m=val.slice(0,caret).match(/(^|\s)\/([a-zA-Z0-9_-]*)$/);
  const start=m?caret-m[2].length-1:caret;
  box.value=val.slice(0,start)+r.text+val.slice(caret);
  const newCaret=start+r.text.length;
  box.focus(); box.setSelectionRange(newCaret,newCaret);
  chatAutosize(box);
  closeSavedReplyPicker();
}

// Saved Replies manager (modalSavedReplies in dashboard.html) — CLIENTS.saved_replies, a plain
// JSON array shared across the whole team, same "settings field the first user to touch it
// creates" convention ensureClientField already uses for qual_questions et al.
let _savedRepliesDraft=[];
function openSavedRepliesModal(){
  let raw=[]; try{raw=JSON.parse(clientRecord?.saved_replies||'[]');}catch(e){}
  _savedRepliesDraft=raw.map(r=>({shortcut:r.shortcut||'', text:r.text||''}));
  renderSavedRepliesEditor();
  openModal('modalSavedReplies');
}
function renderSavedRepliesEditor(){
  const list=$id('savedReplyList');
  if(!_savedRepliesDraft.length){ list.innerHTML='<div style="color:var(--muted);font-size:13px;margin-bottom:8px">No saved replies yet.</div>'; return; }
  list.innerHTML=_savedRepliesDraft.map((r,i)=>`
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:flex-start">
      <input class="form-input" style="width:120px" value="${esc(r.shortcut)}" placeholder="shortcut" oninput="onSavedReplyShortcutInput(${i},this)">
      <textarea class="form-input" style="flex:1" rows="2" placeholder="Reply text" oninput="_savedRepliesDraft[${i}].text=this.value">${esc(r.text)}</textarea>
      <button class="svc-del" onclick="removeSavedReplyRow(${i})">✕</button>
    </div>`).join('');
}
function onSavedReplyShortcutInput(i, el){ _savedRepliesDraft[i].shortcut=el.value.replace(/\s+/g,'-'); }
function addSavedReplyRow(){
  _savedRepliesDraft.push({shortcut:'', text:''});
  renderSavedRepliesEditor();
  $id('savedReplyList').lastElementChild?.querySelector('input')?.focus();
}
function removeSavedReplyRow(i){ _savedRepliesDraft.splice(i,1); renderSavedRepliesEditor(); }
async function saveSavedReplies(){
  const btn=$id('saveSavedReplies'), msg=$id('saveSavedRepliesMsg');
  btn.disabled=true; msg.textContent=''; msg.className='save-msg';
  try{
    const cleaned=_savedRepliesDraft.map(r=>({shortcut:(r.shortcut||'').trim().replace(/^\/+/,''), text:(r.text||'').trim()})).filter(r=>r.shortcut&&r.text);
    await ensureClientField('saved_replies','LongText');
    await patchClient({saved_replies:JSON.stringify(cleaned)});
    msg.textContent='✓ Saved';
  }catch(e){ msg.textContent='Error: '+e.message; msg.className='save-msg err'; }
  finally{ btn.disabled=false; setTimeout(()=>msg.textContent='',3000); }
}

// Image/document attach from the Chats composer — same Chatwoot attachment relay (/quote/send)
// Quotes already uses to send a generated PDF; it just forwards conv_id/caption/file untouched,
// so any file type works. No new backend endpoint needed.
async function chatAttachFile(leadId,file,kind){
  const input=$id(kind==='image'?'chatImgInput':'chatDocInput');
  if(!file){return;}
  const status=$id('chatAttachStatus');
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead){return;}
  const convId=leadConvId(lead);
  if(!convId){status.textContent='No Chatwoot conversation linked to this lead — attachment cannot be sent.';status.className='chat-send-status err';if(input)input.value='';return;}
  const maxBytes=16*1024*1024;
  if(file.size>maxBytes){status.textContent='File too large — max 16 MB.';status.className='chat-send-status err';if(input)input.value='';return;}
  const kindLabel=kind==='image'?'image':'document';
  status.textContent=`Sending ${kindLabel}…`;status.className='chat-send-status';
  try{
    const fd=new FormData();
    fd.append('conv_id',convId);
    fd.append('caption','');
    fd.append('file',file,file.name);
    const r=await fetch(`${CONFIG.WORKER_BASE}/quote/send`,{method:'POST',headers:ncAuthHeaders(),body:fd});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||'HTTP '+r.status);
  }catch(e){
    status.textContent=`Failed to send ${kindLabel}: `+e.message;status.className='chat-send-status err';
    if(input)input.value='';
    return;
  }
  const hist=await freshConvHistory(lead);
  hist.push({role:'assistant',content:(kind==='image'?'🖼️ ':'📎 ')+file.name,ts:new Date().toISOString()});
  try{
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:lead.Id,ConvHistory:JSON.stringify(hist)});
  }catch(e){/* best-effort — the attachment already reached Chatwoot */}
  lead.ConvHistory=JSON.stringify(hist);
  chatSelectLead(leadId);
}

// Internal note — never reaches the customer. Writes straight to NotesList (the same field/shape
// the Lead Detail panel's addNote() already uses, so a note added from either place shows up in
// both), then re-renders the merged timeline via chatSelectLead.
async function chatSubmitNote(leadId, input, msg){
  const text=(input?.value||'').trim();
  if(!text) return;
  const lead=allLeads.find(l=>l.Id===leadId);
  if(!lead) return;
  let notes=[]; try{notes=JSON.parse(lead.NotesList||'[]');}catch(e){}
  notes.unshift({text, date:new Date().toLocaleString(), ts:new Date().toISOString(), author:myEmail});
  const notesStr=JSON.stringify(notes);
  msg.textContent='Saving note…'; msg.className='chat-send-status';
  try{
    await ncPatch(`${CONFIG.NOCODB_BASE}/api/v2/tables/${CONFIG.LEADS_TABLE_ID}/records`,{Id:lead.Id,NotesList:notesStr});
  }catch(e){
    msg.textContent='Failed to save note: '+e.message; msg.className='chat-send-status err';
    return;
  }
  lead.NotesList=notesStr;
  if(currentLead && currentLead.Id===lead.Id){ currentLead.NotesList=notesStr; if(typeof renderDetailNotes==='function') renderDetailNotes(currentLead); }
  input.value='';
  msg.textContent='Note added ✓'; msg.className='chat-send-status';
  chatSelectLead(leadId);
  setTimeout(()=>{if(msg)msg.textContent='';},2500);
}

async function chatSendFromTab(leadId){
  const input=$id('chatReplyBox');
  const msg=$id('chatReplyMsg');
  if(_chatComposerMode==='note') return chatSubmitNote(leadId, input, msg);
  const typed=(input?.value||'').trim();
  if(!typed||!leadId) return;
  // Quote-reply prefix — see chatSetReplyTarget's own comment on why this is a plain-text
  // convention (*bold* renders as real bold on WhatsApp) rather than any native reply metadata.
  const text=_chatReplyTarget?`*↩️ Replying to:* "${_chatReplyTarget.snippet}${_chatReplyTarget.snippet.length>=80?'…':''}"\n\n${typed}`:typed;
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
  clearInterval(_chatHeartbeatTimer);
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
