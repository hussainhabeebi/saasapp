(() => {
  const existing = document.querySelector('script[data-poomas-extension]');
  if (existing) return;

  const script = document.createElement('script');
  script.src = '/live-travel-poomas.js?v=20260823';
  script.async = false;
  script.dataset.poomasExtension = '1';
  script.onload = async () => {
    try {
      if (typeof window.refresh === 'function') {
        await window.refresh(false);
      }
      if (typeof window.show === 'function') {
        window.show(window.page || 'suppliers');
      }
    } catch (err) {
      console.error('POOMAS Live Agency extension initialization failed', err);
    }
  };
  script.onerror = () => console.error('Failed to load /live-travel-poomas.js');
  document.body.appendChild(script);
})();
