/* Standalone Chats hotfix: mobile touch scrolling, reply context, and visible dashboard navigation. */
(function(){
  const css=document.createElement('style');
  css.textContent=`
    .list,.thread{min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior-y:contain!important;touch-action:pan-y!important}
    .sidebar,.main{min-height:0!important;overflow:hidden!important}
    #app{position:relative!important;height:100dvh!important;overflow:hidden!important}
    .chat-dashboard-btn{border:0;border-radius:8px;background:#008069;color:#fff;padding:9px 12px;font-size:13px;font-weight:650;display:flex;align-items:center;gap:6px;white-space:nowrap}
    .chat-dashboard-btn:hover{background:#006f5c}
    .standalone-reply-btn{border:0;background:rgba(255,255,255,.82);color:#54656f;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;opacity:.18;transition:.12s}
    .bubble-row:hover .standalone-reply-btn,.standalone-reply-btn:focus{opacity:1}
    .bubble-row.out .standalone-reply-btn{order:-1}
    .standalone-reply-quote{border-left:3px solid #00a884;background:rgba(255,255,255,.55);border-radius:5px;padding:5px 8px;margin-bottom:5px;color:#54656f;font-size:12px;line-height:1.25}
    .standalone-reply-quote b{display:block;color:#008069;margin-bottom:2px}
    .standalone-reply-preview{background:#f0f2f5;padding:6px 12px 0;display:flex;align-items:stretch;gap:8px;flex:none}
    .standalone-reply-preview.hidden{display:none!important}
    .standalone-reply-card{flex:1;min-width:0;border-left:4px solid #00a884;background:#fff;border-radius:6px;padding:6px 9px;font-size:12px;color:#667781}
    .standalone-reply-card b{display:block;color:#008069;margin-bottom:2px}
    .standalone-reply-card div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .standalone-reply-close{border:0;background:transparent;color:#667781;font-size:20px}
    @media(max-width:700px){
      .sidebar,.main{height:100dvh!important;min-height:0!important;overflow:hidden!important}
      .thread{flex:1 1 0!important;min-height:0!important;padding-bottom:18px!important}
      .list{flex:1 1 0!important;min-height:0!important}
      .standalone-reply-btn{opacity:.82;width:32px;height:32px}
      .chat-dashboard-btn{padding:8px 10px;font-size:12px}
    }
    @media(max-width:380px){.chat-dashboard-btn .chat-dashboard-text{display:none}}
  `;
  document.head.appendChild(css);

  function dashboardUrl(){
    return `dashboard.html?client=${encodeURIComponent(clientId)}&token=${encodeURIComponent(sessionToken)}`;
  }
  function goDashboardHotfix(){ location.href=dashboardUrl(); }
  window.goDashboardHotfix=goDashboardHotfix;

  function makeDashboardButton(){
    const top=document.querySelector('.side-top');
    if(!top) return;
    const existing=top.querySelector('.chat-dashboard-btn');
    if(existing) return;
    const old=[...top.querySelectorAll('button')].find(b=>(b.title||'').toLowerCase().includes('back to dashboard'));
    if(old) old.remove();
    const b=document.createElement('button');
    b.className='chat-dashboard-btn';
    b.title='Back to Dashboard';
    b.innerHTML='← <span class="chat-dashboard-text">Dashboard</span>';
    b.onclick=goDashboardHotfix;
    top.appendChild(b);
  }

  let replyTarget=null;
  const snippet=m=>String(m?.content||m?.attachment?.name||'Message').replace(/\s+/g,' ').trim().slice(0,100);
  function renderReplyPreview(){
    let box=document.getElementById('standaloneReplyPreview');
    const composerMode=document.querySelector('.composer-mode');
    if(!composerMode) return;
    if(!box){
      box=document.createElement('div');
      box.id='standaloneReplyPreview';
      box.className='standalone-reply-preview hidden';
      composerMode.parentNode.insertBefore(box,composerMode);
    }
    if(!replyTarget){box.classList.add('hidden');box.innerHTML='';return;}
    const who=['assistant','bot','agent'].includes(replyTarget.role)?'You':'Customer';
    box.classList.remove('hidden');
    box.innerHTML=`<div class="standalone-reply-card"><b>${esc(who)}</b><div>${esc(replyTarget.snippet)}</div></div><button class="standalone-reply-close" title="Cancel reply">×</button>`;
    box.querySelector('button').onclick=()=>{replyTarget=null;renderReplyPreview();};
  }
  window.setStandaloneReply=function(i){
    if(!current) return;
    const h=hist(current),m=h[i];
    if(!m) return;
    replyTarget={index:i,snippet:snippet(m),role:m.role||'user'};
    renderReplyPreview();
    document.getElementById('msg')?.focus();
  };

  function enhanceThread(){
    makeDashboardButton();
    if(!current) return;
    const h=hist(current);
    document.querySelectorAll('.bubble-row').forEach((row,i)=>{
      const m=h[i]; if(!m) return;
      const bubble=row.querySelector('.bubble');
      if(m.reply_to && bubble && !bubble.querySelector('.standalone-reply-quote')){
        const q=document.createElement('div');
        q.className='standalone-reply-quote';
        q.innerHTML=`<b>${esc(m.reply_to.who||'Reply')}</b>${esc(m.reply_to.snippet||'')}`;
        bubble.insertBefore(q,bubble.firstChild);
      }
      if(!row.querySelector('.standalone-reply-btn')){
        const btn=document.createElement('button');
        btn.className='standalone-reply-btn';btn.title='Reply';btn.textContent='↩';
        btn.onclick=()=>window.setStandaloneReply(i);
        row.appendChild(btn);
      }
    });
    renderReplyPreview();
    const menu=document.getElementById('chatMenu');
    if(menu && !menu.querySelector('.chat-dashboard-menu-item')){
      const b=document.createElement('button');b.className='chat-dashboard-menu-item';b.textContent='← Back to Dashboard';b.style.cssText='color:#008069;font-weight:650;border-top:1px solid #e9edef';b.onclick=goDashboardHotfix;menu.appendChild(b);
    }
  }

  const baseRenderThread=renderThread;
  renderThread=function(scroll=true){
    baseRenderThread(scroll);
    requestAnimationFrame(enhanceThread);
  };

  const baseOpenChat=openChat;
  openChat=function(id){replyTarget=null;baseOpenChat(id);requestAnimationFrame(enhanceThread);};
  const baseCloseChat=closeChat;
  closeChat=function(){replyTarget=null;baseCloseChat();};
  const baseSetMode=setMode;
  setMode=function(m){if(m==='note')replyTarget=null;baseSetMode(m);renderReplyPreview();};

  const baseSendText=sendText;
  sendText=async function(){
    if(!replyTarget || window._mode==='note') return baseSendText();
    if(!current) return;
    const box=document.getElementById('msg'),typed=(box?.value||'').trim();
    if(!typed) return;
    box.disabled=true;showStatus('Sending…');
    try{
      const ig=(current.Channel||'whatsapp')==='instagram',id=convId(current);
      if(!ig&&!id) throw new Error('No linked WhatsApp conversation');
      const activeReply={...replyTarget};
      const text=`*↩️ Replying to:* "${activeReply.snippet}"\n\n${typed}`;
      const url=ig?WORKER+'/instagram/send':WORKER+'/chat/send';
      const payload=ig?{lead_id:current.Id,text}:{conv_id:id,text};
      await apiJson(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const h=hist(current);
      h.push({role:'assistant',content:typed,ts:new Date().toISOString(),reply_to:{snippet:activeReply.snippet,who:['assistant','bot','agent'].includes(activeReply.role)?'You':'Customer'}});
      await patchLead({ConvHistory:JSON.stringify(h),LastMsgAt:new Date().toISOString()});
      replyTarget=null;box.value='';box.style.height='auto';renderThread();renderContacts();
    }catch(e){toast('Send failed: '+e.message)}
    finally{const b=document.getElementById('msg');if(b)b.disabled=false;}
  };

  makeDashboardButton();
})();
