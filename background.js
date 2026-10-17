/* Service worker: al hacer click en el icono, guarda la pestana
   activa en el ultimo Escritorio, o abre la pagina de inicio. */

chrome.action.onClicked.addListener(async (tab) => {
  // Si clicked en una pagina web, guardarla
  if (tab.url && tab.url.startsWith('http')) {
    const data = await chrome.storage.local.get('tablealo_v1');
    const state = data.tablealo_v1;

    if (!state || !state.collections.length) {
      // Sin escritorios: abrir la pagina nueva para que la configure
      chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
      return;
    }

    // Guardar en el escritorio seleccionado, o en el primero
    const targetId = state.ui?.selectedCollection || state.collections[0].id;
    const target = state.collections.find(c => c.id === targetId) || state.collections[0];

    const bmId = `bm_${Date.now().toString(36)}`;
    state.bookmarks[bmId] = {
      id: bmId,
      title: tab.title || tab.url,
      url: tab.url,
      icon: tab.favIconUrl || '',
      note: '',
      tags: []
    };
    target.bookmarks.push(bmId);

    await chrome.storage.local.set({ tablealo_v1: state });
    chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
  }
});