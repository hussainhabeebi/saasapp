/* ── LeadVyne Meta Pixel helper (store, order, booking and onshope pages) ──────────────────────
   Loads the business's own Meta Pixel (its id comes from the page's public client endpoint) and
   pairs every browser event with the server's Conversions API copy of it:
     • fbclid → _fbc: the Meta click id in an ad's landing URL is kept 90 days (cookie + storage),
       so an order placed days later still ties back to the ad.
     • LVPixel.eventId() / LVPixel.capi(id): the page sends the same event id (plus fbc, fbp and the
       page URL) with its order / booking request; the Worker sends that event to Meta's Conversions
       API with that id, so Meta keeps one event and matches it both ways (worker.js metaWebCapiInfo).
     • Optional consent banner (Ads ROI → settings): when on, nothing loads and no ids are shared
       until the visitor taps Allow; Decline is remembered.
   Usage: LVPixel.init({pixelId, consent}); LVPixel.track('ViewContent', {...}, eventId?). ── */
(function(){
  var FBC_KEY='lv_fbc', CONSENT_KEY='lv_pixel_consent';
  var state={id:'', loaded:false, allowed:false, queue:[]};
  function getCookie(n){ var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)')); return m?decodeURIComponent(m[1]):''; }
  function setCookie(n, v, days){ try{ document.cookie=n+'='+encodeURIComponent(v)+'; max-age='+(days*86400)+'; path=/; SameSite=Lax'; }catch(e){} }
  function store(k, v){ try{ if(v===undefined) return localStorage.getItem(k)||''; localStorage.setItem(k, v); }catch(e){ return ''; } }
  // Meta's own format for a click id: fb.1.<ms>.<fbclid>.
  try{
    var fbclid=new URLSearchParams(location.search).get('fbclid');
    if(fbclid && /^[\w-]{10,300}$/.test(fbclid)){ var v='fb.1.'+Date.now()+'.'+fbclid; setCookie('_fbc', v, 90); store(FBC_KEY, v); }
  }catch(e){}
  function fbc(){ return getCookie('_fbc')||store(FBC_KEY); }
  function load(){
    if(state.loaded || !state.id) return;
    state.loaded=true;
    /* Meta's standard base code */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;
      s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', state.id);
    window.fbq('track', 'PageView');
    state.queue.splice(0).forEach(function(a){ window.fbq.apply(null, a); });
  }
  function banner(){
    if(document.getElementById('lvConsent')) return;
    var d=document.createElement('div');
    d.id='lvConsent';
    d.setAttribute('role', 'dialog');
    d.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#111;color:#fff;border-radius:12px;padding:12px 14px;font:14px/1.4 system-ui,sans-serif;display:flex;gap:10px;align-items:center;flex-wrap:wrap;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    d.innerHTML='<span style="flex:1;min-width:200px">We use cookies to measure our ads on Facebook and Instagram.</span>'
      +'<button id="lvConsentNo" style="background:transparent;color:#fff;border:1px solid #666;border-radius:8px;padding:6px 12px">Decline</button>'
      +'<button id="lvConsentYes" style="background:#25D366;color:#fff;border:0;border-radius:8px;padding:6px 12px;font-weight:600">Allow</button>';
    document.body.appendChild(d);
    document.getElementById('lvConsentYes').onclick=function(){ store(CONSENT_KEY, 'yes'); d.remove(); state.allowed=true; load(); };
    document.getElementById('lvConsentNo').onclick=function(){ store(CONSENT_KEY, 'no'); d.remove(); state.queue=[]; };
  }
  window.LVPixel={
    init:function(opts){
      var id=String(opts&&opts.pixelId||'');
      if(!/^\d{5,25}$/.test(id) || state.id) return;
      state.id=id;
      var ask=!!(opts&&opts.consent), said=store(CONSENT_KEY);
      if(!ask || said==='yes'){ state.allowed=true; load(); }
      else if(said!=='no') banner();
    },
    track:function(name, data, eventId){
      if(!state.id) return;
      var args=['track', name, data||{}, eventId?{eventID:eventId}:{}];
      if(state.loaded && window.fbq) window.fbq.apply(null, args);
      else if(!state.allowed) state.queue.push(args);
    },
    eventId:function(prefix){ return (prefix||'web')+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2, 8); },
    // What the page sends with its order / booking so the server's copy matches this browser.
    capi:function(eventId){
      var out={event_id:eventId||'', url:location.href};
      if(state.allowed){ var c=fbc(), p=getCookie('_fbp'); if(c) out.fbc=c; if(p) out.fbp=p; }
      return out;
    },
  };
})();
