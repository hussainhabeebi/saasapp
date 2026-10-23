/* ── Leadvyne Android app (TWA, android/ in this repo) — pop-up handling ─────────────────────────
   Does nothing in a normal browser: it switches on only inside the Android app, which opens
   m.html?src=twa (android/twa-manifest.json startUrl). That flag is kept in sessionStorage, which
   belongs to the app's own tab (the app shares Chrome's localStorage/cookies with the browser, so
   localStorage would leak the flag into ordinary Chrome tabs on the same phone).

   Inside the app every window.open() must end up on screen:
   • about:blank windows the page writes into (report PDFs, print views) → an in-app sheet with an
     iframe, Print and Close — returned in place of the window, so .document.write() works as before;
   • blob: URLs (quote PDF preview, scheduled-report preview) → HTML shows in that sheet; anything
     else (PDF, CSV) is downloaded, since a new tab can't render it on Android;
   • tel: / mailto: / sms: / whatsapp: / intent: → handed straight to Android;
   • this site's own pages (Projects, Email Marketing…) → opened in the app itself, Back returns;
   • other sites (wa.me, Chatwoot, payment pages) → a browser tab; if Chrome blocks it (opened
     after a slow request, so no longer "from a tap"), a bar with an Open button appears instead.
   Loaded by m.html, dashboard.html and chats.html. ── */
(function(){
  var inApp=false;
  try{
    if(/[?&]src=twa(&|$)/.test(location.search)||String(document.referrer).indexOf('android-app://com.leadvyne.app')===0) sessionStorage.setItem('lv_twa','1');
    inApp=sessionStorage.getItem('lv_twa')==='1';
  }catch(e){}
  window.LV_TWA=inApp;
  if(!inApp) return;
  document.documentElement.classList.add('in-twa');

  var nativeOpen=window.open.bind(window);
  var Z=2147483000;
  function el(tag,css,text){ var e=document.createElement(tag); if(css) e.style.cssText=css; if(text) e.textContent=text; return e; }
  function btn(label,primary){ return el('button','border:0;border-radius:12px;padding:9px 14px;font:600 14px -apple-system,Roboto,sans-serif;cursor:pointer;'+(primary?'background:#065F46;color:#fff':'background:#F4F6F8;color:#0B0B0C'),label); }

  // Full-screen sheet holding an iframe; returns {frame, close}.
  function sheet(title){
    var wrap=el('div','position:fixed;inset:0;z-index:'+Z+';background:#fff;display:flex;flex-direction:column');
    var bar=el('div','display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px;border-bottom:1px solid #ECEEF2;flex:none');
    var t=el('div','flex:1;min-width:0;font:700 16px -apple-system,Roboto,sans-serif;color:#0B0B0C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',title||'Preview');
    var print=btn('Print'), close=btn('Close',true);
    var frame=el('iframe','flex:1;width:100%;border:0;background:#fff');
    bar.appendChild(t); bar.appendChild(print); bar.appendChild(close);
    wrap.appendChild(bar); wrap.appendChild(frame);
    (document.body||document.documentElement).appendChild(wrap);
    function done(){ if(wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    close.onclick=done;
    print.onclick=function(){ try{ frame.contentWindow.focus(); frame.contentWindow.print(); }catch(e){} };
    frame.addEventListener('load',function(){ try{ var d=frame.contentDocument; if(d&&d.title) t.textContent=d.title; }catch(e){} });
    return {frame:frame, close:done};
  }
  // A window-like iframe for pages that write their own content (report PDF / print views).
  function blankWindow(){
    var s=sheet('Preview'), w=s.frame.contentWindow;
    try{ w.close=s.close; }catch(e){}
    return w;
  }
  // Chrome blocked the tab — show a bar whose button opens it from a real tap.
  function openBar(url){
    var host=url; try{ host=new URL(url,location.href).host; }catch(e){}
    var bar=el('div','position:fixed;left:12px;right:12px;bottom:calc(90px + env(safe-area-inset-bottom));z-index:'+Z+';display:flex;align-items:center;gap:10px;padding:12px 12px 12px 16px;background:#0B2545;color:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(11,37,69,.3);font:500 14px -apple-system,Roboto,sans-serif');
    var txt=el('div','flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis','Open '+host+'?');
    var go=btn('Open',true), x=btn('✕');
    go.style.background='#fff'; go.style.color='#065F46'; x.style.background='transparent'; x.style.color='#fff';
    bar.appendChild(txt); bar.appendChild(go); bar.appendChild(x);
    document.body.appendChild(bar);
    function done(){ if(bar.parentNode) bar.parentNode.removeChild(bar); }
    go.onclick=function(){ done(); nativeOpen(url,'_blank'); };
    x.onclick=done;
    setTimeout(done,20000);
  }
  function download(url,type){
    var ext=/pdf/.test(type)?'pdf':/csv/.test(type)?'csv':/json/.test(type)?'json':/png/.test(type)?'png':/jpe?g/.test(type)?'jpg':'';
    var a=document.createElement('a'); a.href=url; a.download='leadvyne-'+new Date().toISOString().slice(0,10)+(ext?'.'+ext:'');
    document.body.appendChild(a); a.click(); a.remove();
  }

  window.open=function(url,target,features){
    url=url==null?'':String(url);
    var noopener=/noopener|noreferrer/i.test(String(features||''));
    if(!url||url==='about:blank') return blankWindow();
    if(/^blob:/i.test(url)){
      fetch(url).then(function(r){ return r.blob(); }).then(function(b){
        if(/^text\/html/i.test(b.type)) sheet('Preview').frame.src=url; else download(url,b.type||'');
      }).catch(function(){ download(url,''); });
      return null;
    }
    if(/^(tel|mailto|sms|whatsapp|intent|upi):/i.test(url)){ location.href=url; return null; }
    var abs; try{ abs=new URL(url,location.href); }catch(e){ abs=null; }
    if(abs&&abs.origin===location.origin){
      // From inside Chats (an iframe in m.html) the page opens in the app's top window, not the frame.
      var top=window; try{ if(window.top&&window.top.location.origin===location.origin) top=window.top; }catch(e){}
      top.location.assign(abs.href); return null;
    }
    // No window features: on a phone they only make Chrome treat it as a pop-up window. noopener is
    // applied by hand so the return value still says whether the tab actually opened.
    var w=null; try{ w=nativeOpen(url,'_blank'); }catch(e){}
    if(!w){ openBar(url); return null; }
    if(noopener){ try{ w.opener=null; }catch(e){} return null; }
    return w;
  };
})();
