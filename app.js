/* ================================================================
   Tablealo - Gestor de pestañas y bookmarks
   Datos 100% locales. Sin servidor, sin cuenta, sin cobros.

   ARQUITECTURA:
   - state     = objeto con todo. Se persiste en chrome.storage.local
   - render()  = re-pinta la vista desde el estado
   - las acciones mutan state y luego llaman render()
   ================================================================ */

const STORAGE_KEY = 'tablealo_v1';

/* Modelo de datos:
   spaces      = [{ id, name, color }]
   collections = [{ id, spaceId, name, bookmarks: [ids] }]
   bookmarks   = { id, title, url, icon, note, tags: [] }
*/
let state = {
  spaces: [],
  collections: [],
  bookmarks: {},
  settings: { theme: 'light', view: 'board', bgImage: null, gh: { user:'', repo:'', token:'', branch:'main' } },
  ui: { search: '', selectedCollection: null }
};

let uid = 0;
const genId = (p) => `${p}_${Date.now().toString(36)}_${(++uid).toString(36)}`;

/* ================================================================
   PERSISTENCIA
   Dentro de la extension usamos chrome.storage.local (permite mucho
   mas de 5 MB). Si el archivo se abre fuera de la extension, caemos
   a localStorage para que igual funcione.
   ================================================================ */
const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

async function save() {
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

async function load() {
  if (hasChromeStorage) {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) state = data[STORAGE_KEY];

    // Limpieza: la extension antes se llamaba TabVault y guardaba en
    // 'tabvault_v1'. Ese cajon ya no se usa; lo borramos para no dejarlo
    // ocupando espacio ni confundir a nadie.
    chrome.storage.local.get('tabvault_v1', (old) => {
      if (old && old.tabvault_v1) chrome.storage.local.remove('tabvault_v1');
    });
  } else {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { state = JSON.parse(raw); }
      catch (e) { toast('Datos locales corruptos, empezando limpio'); }
    }
    localStorage.removeItem('tabvault_v1');
  }
  applyTheme();
  applyBackground();
  applyView();
}

/* ================================================================
   IMPORTAR JSON DE TOBY (soporta v4 y formatos anteriores)
   El archivo v4 tiene: { version, groups: [{ name, type, lists }] }
   Los grupos de Toby se convierten en ESPACIOS.
   ================================================================ */
function importToby(json) {
  // Si viene como string, parsear
  if (typeof json === 'string') {
    try { json = JSON.parse(json); }
    catch (e) { toast('El archivo no es JSON valido'); return false; }
  }

  if (!json || !json.groups) {
    toast('No parece un export de Toby');
    return false;
  }

  state.spaces = [];
  state.collections = [];
  state.bookmarks = {};

  const spaceColors = ['#f65077','#4a90e2','#1a9e4b','#f0a020','#9b59b6','#e0563a','#00a5a5','#d94f8a'];

  for (const group of json.groups) {
    const spaceId = genId('sp');
    state.spaces.push({
      id: spaceId,
      name: group.name || 'Sin nombre',
      color: spaceColors[state.spaces.length % spaceColors.length]
    });

    for (const list of (group.lists || [])) {
      const collectionId = genId('col');
      const bookmarkIds = [];

      for (const card of (list.cards || [])) {
        if (!card.url) continue;
        const bmId = genId('bm');
        // customTitle es el nombre que le pusiste tu a mano en Toby
        const title = card.customTitle || card.title || card.url;
        const note = card.customDescription || card.description || '';

        state.bookmarks[bmId] = {
          id: bmId,
          title,
          url: card.url,
          icon: card.favIconUrl || '',
          note,
          tags: []
        };
        bookmarkIds.push(bmId);
      }

      state.collections.push({
        id: collectionId,
        spaceId,
        name: list.title || 'Sin titulo',
        color: nextColor(state.collections.length),
        bookmarks: bookmarkIds,
        folders: [],
        position: state.collections.length
      });
    }
  }

  sortCollections();
  return true;
}

/* Ordena las colecciones por nombre dentro de cada espacio */
function sortCollections() {
  state.collections.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/* ================================================================
   EXPORTAR
   Formato propio (JSON) - se puede reimportar con Importar.
   ================================================================ */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tablealo-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup descargado');
}

/* ================================================================
   SINCRONIZACION CON GITHUB
   Usa la API REST con tu PAT. Todo va a tu repo privado.
   ================================================================ */
async function ghRequest(method, endpoint, body) {
  const { user, repo, token } = state.settings.gh;
  if (!user || !repo || !token) {
    setSyncStatus('Completa usuario, repo y token', 'err');
    return null;
  }
  const url = `https://api.github.com/repos/${user}/${repo}/contents/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json().catch(() => null);
}

async function ghPush() {
  setSyncStatus('Subiendo...');
  try {
    const { branch } = state.settings.gh;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));
    const existing = await ghRequest('GET', 'tablealo.json');

    if (existing && existing.sha) {
      await ghRequest('PUT', 'tablealo.json', {
        message: 'Tablealo sync',
        content,
        sha: existing.sha,
        branch
      });
    } else {
      await ghRequest('PUT', 'tablealo.json', {
        message: 'Tablealo sync inicial',
        content,
        branch
      });
    }
    setSyncStatus('Subido', 'ok');
    toast('Datos subidos a GitHub');
  } catch (e) {
    setSyncStatus('Error: ' + e.message, 'err');
  }
}

async function ghPull() {
  setSyncStatus('Descargando...');
  try {
    const data = await ghRequest('GET', 'tablealo.json');
    if (!data || !data.content) {
      setSyncStatus('No hay datos en GitHub', 'err');
      return;
    }
    const json = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
    if (!confirm('Esto reemplaza tus datos locales con los de GitHub. Continuar?')) {
      setSyncStatus('Cancelado');
      return;
    }
    state = json;
    await save();
    applyTheme(); applyBackground(); applyView();
    render();
    setSyncStatus('Descargado', 'ok');
    toast('Datos restaurados desde GitHub');
  } catch (e) {
    setSyncStatus('Error: ' + e.message, 'err');
  }
}

function setSyncStatus(msg, cls = '') {
  const el = document.getElementById('syncStatus');
  el.textContent = msg;
  el.className = 'settings-status ' + cls;
}

/* ================================================================
   BUSQUEDA CON OPERADORES
   #texto    -> solo colecciones
   %texto    -> global (todas las colecciones)
   ?texto    -> buscar en Google
   !texto    -> preguntar a ChatGPT
   @tag      -> bookmarks con ese tag
   a|b       -> OR
   texto     -> bookmarks dentro de la coleccion seleccionada
   ================================================================ */
function parseQuery(raw) {
  const q = raw.trim();
  const terms = q.split('|').map(s => s.trim()).filter(Boolean);

  if (terms.length > 1) {
    return { type: 'or', terms };
  }
  const t = terms[0] || '';
  if (t.startsWith('#')) return { type: 'collections', term: t.slice(1).toLowerCase() };
  if (t.startsWith('%')) return { type: 'global', term: t.slice(1).toLowerCase() };
  if (t.startsWith('?')) return { type: 'google', term: t.slice(1) };
  if (t.startsWith('!')) return { type: 'chatgpt', term: t.slice(1) };
  if (t.startsWith('@')) return { type: 'tag', term: t.slice(1).toLowerCase() };
  return { type: 'bookmarks', term: t.toLowerCase() };
}

function matches(bookmark, term) {
  if (!term) return true;
  return (
    bookmark.title.toLowerCase().includes(term) ||
    bookmark.url.toLowerCase().includes(term) ||
    (bookmark.note || '').toLowerCase().includes(term)
  );
}

function searchResults(query) {
  const q = parseQuery(query);

  // Redirecciones externas
  if (q.type === 'google')  { window.open('https://google.com/search?q=' + encodeURIComponent(q.term), '_blank'); return []; }
  if (q.type === 'chatgpt') { window.open('https://chatgpt.com/?q=' + encodeURIComponent(q.term), '_blank'); return []; }

  const out = [];

  // Busqueda dentro de los bookmarks
  if (q.type === 'bookmarks' || q.type === 'global' || q.type === 'or') {
    const scope = (q.type === 'bookmarks' && state.ui.selectedCollection)
      ? state.collections.filter(c => c.id === state.ui.selectedCollection)
      : state.collections;

    for (const c of scope) {
      let hits;
      if (q.type === 'or') {
        hits = c.bookmarks.map(id => state.bookmarks[id])
          .filter(b => b && q.terms.some(t => matches(b, t.toLowerCase())));
      } else {
        hits = c.bookmarks.map(id => state.bookmarks[id]).filter(b => b && matches(b, q.term));
      }
      if (hits.length) {
        out.push({ type: 'collection', collection: c, space: state.spaces.find(s => s.id === c.spaceId), bookmarks: hits });
      }
    }
    return out;
  }

  // Los demas operadores matchean por nombre de coleccion o por tag
  for (const col of state.collections) {
    const space = state.spaces.find(s => s.id === col.spaceId);

    if (q.type === 'collections') {
      if (col.name.toLowerCase().includes(q.term)) {
        out.push({ type: 'collection', collection: col, space });
      }
      continue;
    }

    if (q.type === 'tag') {
      const hits = col.bookmarks
        .map(id => state.bookmarks[id])
        .filter(b => b && (b.tags || []).some(tag => tag.toLowerCase() === q.term));
      if (hits.length) out.push({ type: 'collection', collection: col, space, bookmarks: hits });
    }
  }
  return out;
}

/* ================================================================
   RENDER PRINCIPAL
   ================================================================ */
function render() {
  const hasContent = state.collections.length > 0;
  document.body.classList.toggle('has-content', hasContent);
  renderSidebar();
  renderBoard();
  if (document.body.classList.contains('view-canvas')) renderCanvas();
}

/* ---- SIDEBAR ---- */
function renderSidebar() {
  const list = document.getElementById('sidebarList');
  const q = state.ui.search.trim();

  // Con busqueda, mostrar resultados en el sidebar
  if (q) {
    const results = searchResults(q);
    if (results.length === 0) {
      list.innerHTML = '<div class="cc-empty">Sin resultados</div>';
      document.getElementById('stats').textContent = '0 resultados';
      return;
    }
    list.innerHTML = results.map(r => {
      const count = r.bookmarks ? r.bookmarks.length : r.collection.bookmarks.length;
      return `<div class="collection-item" data-col="${r.collection.id}">
        <span class="col-icon">📁</span>
        <span class="col-name">${esc(r.collection.name)}</span>
        <span class="col-count">${count}</span>
      </div>`;
    }).join('');
    document.getElementById('stats').textContent = results.length + ' colecciones';
    bindSidebar();
    return;
  }

  // Vista normal: espacios > colecciones > carpetas
  const totalBm = Object.keys(state.bookmarks).length;
  document.getElementById('stats').textContent = `${state.collections.length} colecciones · ${totalBm} bookmarks`;

  list.innerHTML = state.spaces.map(space => {
    const cols = state.collections.filter(c => c.spaceId === space.id);
    const colCount = cols.reduce((n, c) => n + colTotal(c), 0);
    return `
      <div class="space open" data-space="${space.id}">
        <div class="space-header">
          <span class="space-chevron">▶</span>
          <span class="space-dot" style="background:${space.color}"></span>
          <span class="space-name">${esc(space.name)}</span>
          <span class="space-count">${cols.length} · ${colCount}</span>
          <button class="space-add" data-act="add-collection" data-space="${space.id}" title="Añadir colección a este grupo">+</button>
        </div>
        <div class="space-collections">
          ${cols.map(col => `
            <div class="col-group">
              <div class="collection-item ${col.id === state.ui.selectedCollection && !state.ui.selectedFolder ? 'active' : ''}" data-col="${col.id}">
                ${col.folders.length
                  ? `<span class="chevron ${state.ui.selectedCollection === col.id ? 'down' : ''}">▶</span>`
                  : '<span class="chevron spacer"></span>'}
                <span class="col-icon">📁</span>
                <span class="col-name">${esc(col.name)}</span>
                <span class="col-count">${colTotal(col)}</span>
              </div>
              ${col.folders.length ? `
                <div class="folder-group ${state.ui.selectedCollection === col.id ? 'open' : ''}" data-col="${col.id}">
                  <div class="folder-group-items">
                    ${col.folders.map(f => `
                      <div class="folder-item ${state.ui.selectedFolder === f.id ? 'active' : ''}"
                           data-col="${col.id}" data-folder="${f.id}">
                        <span class="col-icon">🗂</span>
                        <span class="col-name">${esc(f.name)}</span>
                        <span class="col-count">${f.bookmarks.length}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
  bindSidebar();
}

/* Total de bookmarks de una coleccion: los directos + los de sus carpetas */
function colTotal(col) {
  const direct = (col.bookmarks || []).length;
  const inFolders = (col.folders || []).reduce((n, f) => n + f.bookmarks.length, 0);
  return direct + inFolders;
}

function bindSidebar() {
  document.querySelectorAll('.space-header').forEach(h => {
    h.addEventListener('click', e => {
      // El boton + del grupo no debe desplegarlo
      if (e.target.closest('.space-add')) return;
      h.parentElement.classList.toggle('open');
    });
  });

  // Boton + de cada grupo: crear coleccion dentro de ese grupo
  document.querySelectorAll('#sidebarList .space-add').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const spaceId = btn.dataset.space;
      const space = state.spaces.find(s => s.id === spaceId);
      const name = prompt(`Nombre de la nueva coleccion en "${space ? space.name : ''}":`);
      if (!name) return;
      const colId = genId('col');
      state.collections.push({
        id: colId,
        spaceId,
        name: name.trim(),
        color: nextColor(state.collections.length),
        bookmarks: [],
        folders: [],
        position: state.collections.length
      });
      state.ui.selectedCollection = colId;
      state.ui.selectedFolder = null;
      // Asegurar que el grupo este expandido
      const group = btn.closest('.space');
      group?.classList.add('open');
      save(); render();
      toast('Coleccion creada');
    });
  });

  // Carpetas: seleccionar coleccion + carpeta
  document.querySelectorAll('#sidebarList [data-folder]').forEach(f => {
    f.addEventListener('click', () => {
      state.ui.selectedCollection = f.dataset.col;
      state.ui.selectedFolder = f.dataset.folder;
      render();
    });
    f.addEventListener('dragover', e => { e.preventDefault(); f.classList.add('drop-target'); });
    f.addEventListener('dragleave', () => f.classList.remove('drop-target'));
    f.addEventListener('drop', e => {
      e.preventDefault();
      f.classList.remove('drop-target');
      const url = e.dataTransfer.getData('text/url');
      const bmId = e.dataTransfer.getData('text/bookmark-id');
      if (url) addBookmarkToFolder(f.dataset.col, f.dataset.folder, url);
      else if (bmId) moveBookmarkToFolder(bmId, f.dataset.col, f.dataset.folder);
    });
  });

  // Colecciones (sin atributo folder)
  document.querySelectorAll('#sidebarList .collection-item[data-col]').forEach(c => {
    c.addEventListener('click', () => {
      const colId = c.dataset.col;
      const col = state.collections.find(x => x.id === colId);

      // Si la coleccion tiene carpetas, el click despliega/selecciona
      if (col && col.folders.length) {
        const group = c.closest('.col-group')?.querySelector('.folder-group');
        if (group) {
          const abria = group.classList.contains('open');
          group.classList.toggle('open');
          c.querySelector('.chevron')?.classList.toggle('down', !abria);
          if (abria) {
            state.ui.selectedCollection = null;
            state.ui.selectedFolder = null;
          } else {
            state.ui.selectedCollection = colId;
            state.ui.selectedFolder = null;
          }
          render();
          return;
        }
      }

      state.ui.selectedCollection = colId;
      state.ui.selectedFolder = null;
      render();
    });
    // drop de pestanas abiertas
    c.addEventListener('dragover', e => { e.preventDefault(); c.classList.add('drop-target'); });
    c.addEventListener('dragleave', () => c.classList.remove('drop-target'));
    c.addEventListener('drop', e => {
      e.preventDefault();
      c.classList.remove('drop-target');
      const url = e.dataTransfer.getData('text/url');
      const bmId = e.dataTransfer.getData('text/bookmark-id');
      if (url) addBookmarkToCollection(c.dataset.col, url);
      else if (bmId) moveBookmark(bmId, c.dataset.col);
    });
  });
}

/* ---- TABLERO ---- */
function renderBoard() {
  const q = state.ui.search.trim();
  const board = document.getElementById('board');

  let collectionsToShow = state.collections;
  if (state.ui.selectedCollection) {
    collectionsToShow = state.collections.filter(c => c.id === state.ui.selectedCollection);
  }
  if (q) {
    // En busqueda, mostrar solo colecciones con coincidencias
    collectionsToShow = searchResults(q).map(r => r.collection);
  }

  if (collectionsToShow.length === 0) {
    board.innerHTML = '';
    return;
  }

  board.innerHTML = collectionsToShow.map(col => {
    const space = state.spaces.find(s => s.id === col.spaceId);
    const folders = col.folders || [];
    const directBms = col.bookmarks.map(id => state.bookmarks[id]).filter(Boolean);
    const total = colTotal(col);
    const onlyFolder = state.ui.selectedFolder
      ? folders.find(f => f.id === state.ui.selectedFolder)
      : null;

    const rowHtml = (bm) => `
      <div class="bm-row" data-bm="${bm.id}" data-url="${esc(bm.url)}" draggable="true">
        <img class="bm-icon" src="${esc(bm.icon)}" onerror="this.style.visibility='hidden'" alt="">
        <div class="bm-text">
          <div class="bm-title">${esc(bm.title)}</div>
          <div class="bm-url">${esc(bm.url.replace(/^https?:\/\//, '').slice(0, 60))}</div>
        </div>
        <div class="bm-tools">
          <button class="icon-btn bm-edit" data-act="edit-bm" data-bm="${bm.id}" title="Renombrar">✎</button>
          <button class="icon-btn bm-del" data-act="delete-bm" data-bm="${bm.id}" title="Eliminar">✕</button>
        </div>
      </div>`;

    const folderBlock = (folder) => `
      <div class="cc-folder" data-folder="${folder.id}" data-col="${col.id}">
        <div class="cc-folder-header">
          <span class="col-icon">🗂</span>
          <span class="cc-folder-name">${esc(folder.name)}</span>
          <span class="cc-folder-count">${folder.bookmarks.length}</span>
          <button class="icon-btn bm-del" data-act="delete-folder" data-col="${col.id}" data-folder="${folder.id}" title="Eliminar carpeta">✕</button>
        </div>
        ${folder.bookmarks.length === 0
          ? '<div class="cc-empty small">Vacía</div>'
          : folder.bookmarks.map(id => state.bookmarks[id]).filter(Boolean).map(bm => rowHtml(bm)).join('')}
      </div>`;

    const contentHtml = onlyFolder
      ? (onlyFolder.bookmarks.length === 0
          ? '<div class="cc-empty">Esta carpeta está vacía</div>'
          : onlyFolder.bookmarks.map(id => state.bookmarks[id]).filter(Boolean).map(bm => rowHtml(bm)).join(''))
      : (folders.length ? folders.map(folderBlock).join('') : '') +
        (directBms.length
          ? (folders.length ? '<div class="cc-subsection">Sin carpeta</div>' : '') +
            directBms.map(bm => rowHtml(bm)).join('')
          : (folders.length ? '' : '<div class="cc-empty">Sin bookmarks</div>'));

    // Cuando estas dentro de una carpeta, el boton de papelera borra la CARPETA
    const deleteBtn = onlyFolder
      ? `<button class="icon-btn" data-act="delete-folder" data-col="${col.id}" data-folder="${onlyFolder.id}" title="Eliminar carpeta">🗑</button>`
      : `<button class="icon-btn" data-act="delete-col" data-col="${col.id}" title="Eliminar colección">🗑</button>`;

    return `
      <div class="collection-card" data-col="${col.id}">
        <div class="cc-header">
          <span class="cc-space-dot" style="background:${space ? space.color : '#888'}"></span>
          <div style="flex:1;min-width:0">
            <div class="cc-title">${esc(onlyFolder ? onlyFolder.name : col.name)}</div>
            <div class="cc-space">${esc(onlyFolder ? col.name : (space ? space.name : ''))}</div>
          </div>
          <div class="cc-actions">
            ${onlyFolder
              ? `<button class="icon-btn" data-act="back-to-collection" data-col="${col.id}" title="Volver a la colección">←</button>`
              : ''}
            <button class="icon-btn" data-act="open-group" data-col="${col.id}" title="Abrir como grupo de pestañas">⊞</button>
            ${deleteBtn}
          </div>
        </div>
        <div class="cc-list">
          ${contentHtml}
        </div>
        <div class="cc-footer">
          <span class="cc-meta">${onlyFolder ? onlyFolder.bookmarks.length : total} bookmarks</span>
          ${onlyFolder ? `<button class="btn btn-sm" data-act="back-to-collection" data-col="${col.id}">Volver</button>` : ''}
          <button class="btn btn-sm" data-act="open-all" data-col="${col.id}">Abrir todo</button>
        </div>
      </div>`;
  }).join('');

  bindBoard();
}

function bindBoard() {
  // Click en bookmark abre
  document.querySelectorAll('#board .bm-row').forEach(r => {
    r.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      window.open(r.dataset.url, '_blank');
    });
    // Arrastrar bookmark a otra coleccion o carpeta
    r.addEventListener('dragstart', e => {
      r.classList.add('dragging');
      e.dataTransfer.setData('text/bookmark-id', r.dataset.bm);
    });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
  });

  // Carpetas dentro de las cards: click entra a la carpeta, drop recibe bookmarks
  document.querySelectorAll('#board .cc-folder').forEach(f => {
    f.addEventListener('click', e => {
      if (e.target.closest('[data-act]')) return;
      state.ui.selectedCollection = f.dataset.col;
      state.ui.selectedFolder = f.dataset.folder;
      render();
    });
    f.addEventListener('dragover', e => { e.preventDefault(); f.classList.add('drop-target'); });
    f.addEventListener('dragleave', () => f.classList.remove('drop-target'));
    f.addEventListener('drop', e => {
      e.preventDefault();
      f.classList.remove('drop-target');
      const bmId = e.dataTransfer.getData('text/bookmark-id');
      const url = e.dataTransfer.getData('text/url');
      if (bmId) moveBookmarkToFolder(bmId, f.dataset.col, f.dataset.folder);
      else if (url) addBookmarkToFolder(f.dataset.col, f.dataset.folder, url);
    });
  });

  // Cards aceptan drop
  document.querySelectorAll('#board .collection-card').forEach(card => {
    card.addEventListener('dragover', e => {
      // Si el puntero esta sobre una carpeta, que la carpeta reciba el drop
      if (e.target.closest('.cc-folder')) return;
      e.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', e => {
      if (e.target.closest('.cc-folder')) return;
      e.preventDefault();
      card.classList.remove('drop-target');
      const bmId = e.dataTransfer.getData('text/bookmark-id');
      const url = e.dataTransfer.getData('text/url');
      if (bmId) moveBookmark(bmId, card.dataset.col);
      else if (url) addBookmarkToCollection(card.dataset.col, url);
    });
  });

  // Botones de accion
  document.querySelectorAll('#board [data-act]').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const act = b.dataset.act;
      const colId = b.dataset.col;
      const bmId = b.dataset.bm;
      const folderId = b.dataset.folder;

      if (act === 'delete-bm') deleteBookmark(bmId);
      if (act === 'edit-bm') startEditTitle(bmId);
      if (act === 'delete-col') deleteCollection(colId);
      if (act === 'delete-folder') deleteFolder(colId, folderId);
      if (act === 'open-group') openCollectionAsGroup(colId);
      if (act === 'open-all') openCollectionAsGroup(colId);
      if (act === 'add-folder') promptNewFolder(colId);
      if (act === 'back-to-collection') {
        state.ui.selectedFolder = null;
        render();
      }
    });
  });
}

/* ---- CANVAS (mapa visual con drill-down) ----
   Con 182 colecciones un mapa radial de una sola vez resulta ilegible:
   todos los nombres se enciman. Por eso tiene dos niveles:
     nivel 1 = los espacios (visibles de un vistazo)
     nivel 2 = las colecciones de UN espacio (click en el espacio)
   Click en una coleccion la selecciona y vuelve al tablero. */
let canvasLevel = 'spaces';
let canvasSpace = null;

function renderCanvas() {
  const svg = document.getElementById('canvas');
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) * 0.36;

  let html = '';

  if (canvasLevel === 'space') {
    html += `<text x="${cx}" y="34" text-anchor="middle" fill="var(--fg-muted)" font-size="12" style="cursor:pointer" id="canvasBack">volver a todos los espacios</text>`;
  }

  if (canvasLevel === 'spaces') {
    const n = state.spaces.length || 1;
    state.spaces.forEach((space, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const cols = state.collections.filter(c => c.spaceId === space.id);
      const bms = cols.reduce((acc, c) => acc + c.bookmarks.length, 0);
      const r = Math.min(46, 21 + cols.length * 0.85);

      html += `<line class="edge" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" opacity="0.5"/>`;
      html += `<g class="node" data-space="${space.id}" style="cursor:pointer">
        <circle cx="${x}" cy="${y}" r="${r}" fill="${space.color}" opacity="0.92"/>
        <text x="${x}" y="${y - 1}" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">${esc(space.name.slice(0, 16))}</text>
        <text x="${x}" y="${y + 11}" text-anchor="middle" fill="#fff" font-size="8" opacity="0.85">${cols.length} col · ${bms} links</text>
      </g>`;
    });

    html += `<g>
      <circle cx="${cx}" cy="${cy}" r="34" fill="var(--accent)" opacity="0.15"/>
      <circle cx="${cx}" cy="${cy}" r="24" fill="var(--accent)"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${state.collections.length} col</text>
    </g>`;
  } else {
    const space = state.spaces.find(s => s.id === canvasSpace);
    const cols = state.collections.filter(c => c.spaceId === canvasSpace);
    const n = cols.length || 1;
    const twoRings = n > 18;
    const firstRing = twoRings ? Math.ceil(n / 2) : n;

    html += `<text x="${cx}" y="${cy - radius * 0.95}" text-anchor="middle" fill="var(--fg)" font-size="16" font-weight="600">${esc(space ? space.name : '')}</text>`;

    cols.forEach((col, j) => {
      const onSecond = twoRings && j >= firstRing;
      const idx = onSecond ? j - firstRing : j;
      const ringN = onSecond ? n - firstRing : firstRing;
      const r = onSecond ? radius : radius * 0.66;
      const angle = (idx / Math.max(ringN, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      html += `<line class="edge" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" opacity="0.3"/>`;
      html += `<g class="node" data-col="${col.id}" style="cursor:pointer">
        <circle cx="${x}" cy="${y}" r="6" fill="${space ? space.color : '#888'}"/>
        <text x="${x}" y="${y - 12}" text-anchor="middle" fill="var(--fg)" font-size="9" opacity="0.92">${esc(col.name.slice(0, 20))}</text>
        <text x="${x}" y="${y + 18}" text-anchor="middle" fill="var(--fg-muted)" font-size="7.5">${col.bookmarks.length}</text>
      </g>`;
    });

    html += `<g>
      <circle cx="${cx}" cy="${cy}" r="28" fill="var(--accent)" opacity="0.15"/>
      <circle cx="${cx}" cy="${cy}" r="20" fill="var(--accent)"/>
    </g>`;
  }

  svg.innerHTML = html;

  svg.querySelectorAll('[data-space]').forEach(g => {
    g.addEventListener('click', () => {
      canvasLevel = 'space';
      canvasSpace = g.dataset.space;
      renderCanvas();
    });
  });

  svg.querySelectorAll('[data-col]').forEach(g => {
    g.addEventListener('click', () => {
      state.ui.selectedCollection = g.dataset.col;
      setView('board');
      render();
    });
  });

  const back = svg.querySelector('#canvasBack');
  if (back) {
    back.addEventListener('click', () => {
      canvasLevel = 'spaces';
      canvasSpace = null;
      renderCanvas();
    });
  }
}

/* ================================================================
   ACCIONES
   ================================================================ */
/* Quita un bookmark de donde este, este en coleccion o carpeta */
function detachBookmark(bmId) {
  for (const col of state.collections) {
    col.bookmarks = (col.bookmarks || []).filter(id => id !== bmId);
    for (const f of (col.folders || [])) {
      f.bookmarks = f.bookmarks.filter(id => id !== bmId);
    }
  }
}

/* Todos los bookmarks de una coleccion, incluyendo los de sus carpetas */
function allBookmarksOf(col) {
  const ids = [...(col.bookmarks || [])];
  for (const f of (col.folders || [])) ids.push(...f.bookmarks);
  return ids.map(id => state.bookmarks[id]).filter(Boolean);
}

/* Edita SOLO el titulo de un bookmark. La URL nunca se toca.
   Reemplaza la fila por un input; Enter guarda, Escape cancela,
   y hacer click fuera tambien guarda. */
function startEditTitle(bmId) {
  const row = document.querySelector(`#board .bm-row[data-bm="${bmId}"]`);
  const bm = state.bookmarks[bmId];
  if (!row || !bm) return;

  const textBox = row.querySelector('.bm-text');
  if (!textBox) return;

  const original = bm.title;

  // Guardamos la URL actual para poder verificar que no cambie
  const urlBefore = bm.url;

  textBox.innerHTML = `
    <input class="bm-edit-input" type="text" value="${esc(original)}" maxlength="200">
    <div class="bm-edit-hint">Enter para guardar · Escape para cancelar</div>
  `;

  const input = textBox.querySelector('.bm-edit-input');
  input.focus();
  input.select();

  let done = false;

  const finish = (guardar) => {
    if (done) return;
    done = true;
    try {
      if (guardar) {
        const nuevo = input.value.trim();
        // Solo si el usuario escribio algo distinto y no vacio
        if (nuevo && nuevo !== original) {
          bm.title = nuevo;
          bm.customTitle = nuevo;   // se guarda como titulo propio
          save();
          toast('Titulo actualizado');
        }
      }
    } catch (err) {
      // Si algo falla al guardar, la fila debe cerrarse igual
      console.error('Error al guardar el titulo:', err);
    }
    render();   // siempre se cierra el modo edicion
  };

  input.addEventListener('keydown', e => {
    e.stopPropagation();   // que Ctrl+K no se active escribiendo
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });

  input.addEventListener('blur', () => finish(true));

  // Verificacion: la URL debe seguir intacta
  if (bm.url !== urlBefore) {
    console.error('BUG: la URL cambio al editar el titulo');
  }
}

function deleteBookmark(bmId) {
  detachBookmark(bmId);
  delete state.bookmarks[bmId];
  save(); render();
}

function deleteCollection(colId) {
  if (!confirm('Eliminar esta coleccion y sus bookmarks?')) return;
  const col = state.collections.find(c => c.id === colId);
  if (col) allBookmarksOf(col).forEach(bm => delete state.bookmarks[bm.id]);
  state.collections = state.collections.filter(c => c.id !== colId);
  if (state.ui.selectedCollection === colId) {
    state.ui.selectedCollection = null;
    state.ui.selectedFolder = null;
  }
  save(); render();
}

function deleteFolder(colId, folderId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  const folder = (col.folders || []).find(f => f.id === folderId);
  if (!folder) return;
  if (!confirm(`Eliminar la carpeta "${folder.name}"?`)) return;
  folder.bookmarks.forEach(id => delete state.bookmarks[id]);
  col.folders = col.folders.filter(f => f.id !== folderId);
  if (state.ui.selectedFolder === folderId) state.ui.selectedFolder = null;
  save(); render();
  toast('Carpeta eliminada');
}

/* Paleta de circulos para colecciones y carpetas */
const COLLECTION_COLORS = [
  '#e0563a', '#4a90e2', '#1a9e4b', '#f0a020', '#9b59b6', '#00a5a5',
  '#d94f8a', '#c0392b', '#16a085', '#8e44ad', '#d35400', '#27ae60'
];

function nextColor(index) {
  return COLLECTION_COLORS[index % COLLECTION_COLORS.length];
}

/* Crea una carpeta dentro de una coleccion */
function addFolder(colId, name) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;
  if (!col.folders) col.folders = [];
  const folder = {
    id: genId('fld'),
    name,
    bookmarks: [],
    color: nextColor(col.folders.length)
  };
  col.folders.push(folder);
  state.ui.selectedCollection = colId;
  state.ui.selectedFolder = folder.id;
  save(); render();
  toast('Carpeta creada');
}

function moveBookmark(bmId, toColId) {
  detachBookmark(bmId);
  const dest = state.collections.find(c => c.id === toColId);
  if (dest) dest.bookmarks.push(bmId);
  save(); render();
  toast('Bookmark movido');
}

function moveBookmarkToFolder(bmId, colId, folderId) {
  detachBookmark(bmId);
  const col = state.collections.find(c => c.id === colId);
  const folder = col && (col.folders || []).find(f => f.id === folderId);
  if (folder) folder.bookmarks.push(bmId);
  save(); render();
  toast('Bookmark movido a la carpeta');
}

async function addBookmarkToCollection(colId, url) {
  let title = url;
  let icon = '';
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    title = tab.title || url;
    icon = tab.favIconUrl || '';
    await chrome.tabs.remove(tab.id);
  } catch (e) {}

  const bmId = genId('bm');
  state.bookmarks[bmId] = { id: bmId, title, url, icon, note: '', tags: [] };
  const col = state.collections.find(c => c.id === colId);
  if (col) col.bookmarks.push(bmId);
  save(); render();
  toast('Bookmark agregado');
}

async function addBookmarkToFolder(colId, folderId, url) {
  let title = url;
  let icon = '';
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    title = tab.title || url;
    icon = tab.favIconUrl || '';
    await chrome.tabs.remove(tab.id);
  } catch (e) {}

  const bmId = genId('bm');
  state.bookmarks[bmId] = { id: bmId, title, url, icon, note: '', tags: [] };
  const col = state.collections.find(c => c.id === colId);
  const folder = col && (col.folders || []).find(f => f.id === folderId);
  if (folder) folder.bookmarks.push(bmId);
  save(); render();
  toast('Bookmark agregado a la carpeta');
}

/* Reabre una coleccion como grupo de pestanas de Chrome */
async function openCollectionAsGroup(colId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;

  // Si hay una carpeta seleccionada, abre solo esa
  const folder = state.ui.selectedFolder
    ? (col.folders || []).find(f => f.id === state.ui.selectedFolder)
    : null;
  const ids = folder ? folder.bookmarks : allBookmarksOf(col).map(b => b.id);
  if (ids.length === 0) return;

  const urls = ids.map(id => state.bookmarks[id]).filter(Boolean).map(b => b.url);
  const tabIds = await chrome.tabs.create({ url: urls, active: false });

  // Agrupar si el navegador lo soporta
  try {
    await chrome.tabs.group({ tabIds, groupId: -1 });
    await chrome.tabGroups.update(-1, { title: folder ? folder.name : col.name, color: 'blue' });
    await chrome.tabs.update(tabIds[0], { active: true });
  } catch (e) {
    toast('Abierto en pestanas separadas (sin agrupar)');
  }
}

/* ================================================================
   PESTANAS ABIERTAS
   Solo funcionan dentro de la extension. Fuera de ella no hay API,
   asi que el panel simplemente muestra un aviso.
   ================================================================ */
const hasChromeTabs = typeof chrome !== 'undefined' && chrome.tabs;

async function loadOpenTabs() {
  const list = document.getElementById('openTabsList');

  if (!hasChromeTabs) {
    list.innerHTML = '<div class="cc-empty">Solo disponible dentro de la extension de Chrome</div>';
    return;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });

  // Filtrar nuestra propia pestana y paginas internas
  const filtered = tabs.filter(t => !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));

  list.innerHTML = filtered.map((t, i) => `
    <div class="tab-item" draggable="true" data-url="${esc(t.url)}" data-tabid="${t.id}">
      <img class="tab-icon" src="${esc(t.favIconUrl || '')}" onerror="this.style.visibility='hidden'" alt="">
      <span class="tab-title">${esc(t.title || t.url)}</span>
      ${t.groupId !== -1 ? '<span class="tab-group">grupo</span>' : ''}
    </div>
  `).join('');

  // Arrastrar pestana abierta a una coleccion / click para enfocarla
  list.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      item.classList.add('dragging');
      e.dataTransfer.setData('text/url', item.dataset.url);
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.tabid, 10);
      if (!isNaN(id)) chrome.tabs.update(id, { active: true });
    });
  });
}

/* Captura la ventana actual como una nueva coleccion */
async function captureWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const valid = tabs.filter(t => t.url.startsWith('http'));
  if (valid.length === 0) { toast('No hay pestanas web abiertas'); return; }

  const name = prompt('Nombre de la coleccion:', 'Session ' + new Date().toLocaleDateString('es'));
  if (!name) return;

  const spaceId = state.spaces[0]?.id || createDefaultSpace();
  const colId = genId('col');
  const bmIds = [];

  for (const t of valid) {
    const bmId = genId('bm');
    state.bookmarks[bmId] = { id: bmId, title: t.title || t.url, url: t.url, icon: t.favIconUrl || '', note: '', tags: [] };
    bmIds.push(bmId);
  }

  state.collections.push({ id: colId, spaceId, name, color: nextColor(state.collections.length), bookmarks: bmIds, folders: [], position: state.collections.length });
  save(); render();
  toast(`${valid.length} pestanas capturadas`);
}

function createDefaultSpace() {
  const id = genId('sp');
  state.spaces.push({ id, name: 'General', color: '#f65077' });
  return id;
}

/* ================================================================
   TEMA, FONDO, VISTAS
   ================================================================ */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme || 'light');
}

function applyBackground() {
  if (state.settings.bgImage) {
    document.body.style.setProperty('--custom-bg', `url(${state.settings.bgImage})`);
    document.body.classList.add('has-bg');
  } else {
    document.body.classList.remove('has-bg');
  }
}

function applyView() {
  const v = state.settings.view || 'board';
  document.body.classList.remove('view-board', 'view-canvas');
  document.body.classList.add('view-' + v);
  document.getElementById('btnBoard').classList.toggle('active', v === 'board');
  document.getElementById('btnCanvas').classList.toggle('active', v === 'canvas');
}

function setView(v) {
  state.settings.view = v;
  applyView();
  save();
  render();
}

/* ================================================================
   UI HELPERS
   ================================================================ */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function pickFile() {
  document.getElementById('filePicker').click();
}

function closeNewMenu() {
  document.getElementById('newMenu').classList.remove('show');
}

/* Pide el nombre de una carpeta y la crea en la coleccion indicada */
function promptNewFolder(colId) {
  const name = prompt('Nombre de la nueva carpeta:');
  if (!name) return;
  addFolder(colId, name.trim());
}

/* ================================================================
   MODO ZEN
   ================================================================ */
let zenInterval;

function toggleZen(on) {
  document.body.classList.toggle('zen-on', on);
  if (on) {
    updateZenClock();
    zenInterval = setInterval(updateZenClock, 1000);
    setTimeout(() => document.getElementById('zenSearch').focus(), 60);
  } else {
    clearInterval(zenInterval);
    document.getElementById('zenSearch').value = '';
    document.getElementById('zenResults').innerHTML = '';
  }
}

function updateZenClock() {
  const now = new Date();
  document.getElementById('zenClock').textContent =
    now.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function renderZenResults(query) {
  const box = document.getElementById('zenResults');
  if (!query.trim()) { box.innerHTML = ''; return; }

  const results = searchResults(query).flatMap(r => {
    const bms = r.bookmarks || r.collection.bookmarks.map(id => state.bookmarks[id]).filter(Boolean);
    return bms.slice(0, 8).map(bm => ({ bm, col: r.collection }));
  }).slice(0, 20);

  if (results.length === 0) { box.innerHTML = '<div class="zen-empty">Nada encontrado</div>'; return; }

  box.innerHTML = results.map(r => `
    <div class="zen-result" data-url="${esc(r.bm.url)}">
      <img class="zr-icon" src="${esc(r.bm.icon)}" onerror="this.style.visibility='hidden'" alt="">
      <span class="zr-title">${esc(r.bm.title)}</span>
      <span class="zr-path">${esc(r.col.name)}</span>
    </div>`).join('');

  box.querySelectorAll('.zen-result').forEach(el => {
    el.addEventListener('click', () => window.open(el.dataset.url, '_blank'));
  });
}

/* ================================================================
   EVENTOS
   ================================================================ */
function bindEvents() {
  // Busqueda
  document.getElementById('search').addEventListener('input', e => {
    state.ui.search = e.target.value;
    render();
  });

  document.getElementById('zenSearch').addEventListener('input', e => {
    renderZenResults(e.target.value);
  });

  // Vistas
  document.getElementById('btnBoard').addEventListener('click', () => setView('board'));
  document.getElementById('btnCanvas').addEventListener('click', () => setView('canvas'));

  // Zen
  document.getElementById('btnZen').addEventListener('click', () => toggleZen(!document.body.classList.contains('zen-on')));
  document.getElementById('zenExit').addEventListener('click', () => toggleZen(false));

  // Tema
  document.getElementById('btnTheme').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); save();
  });

  // Sidebar toggle
  document.getElementById('btnSidebar').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-hidden');
  });

  // Panel de pestanas
  document.getElementById('btnRefreshTabs').addEventListener('click', loadOpenTabs);
  document.getElementById('btnCaptureWindow').addEventListener('click', captureWindow);
  document.getElementById('btnCloseTabsPanel').addEventListener('click', () => {
    document.body.classList.add('tabs-hidden');
  });

  // Import / export
  document.getElementById('btnImport').addEventListener('click', pickFile);
  document.getElementById('btnImportEmpty').addEventListener('click', pickFile);
  document.getElementById('btnExport').addEventListener('click', exportData);

  document.getElementById('filePicker').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const ok = importToby(text);
    if (ok) {
      await save();
      render();
      const n = Object.keys(state.bookmarks).length;
      toast(`Importados ${state.collections.length} colecciones · ${n} bookmarks`);
    }
    e.target.value = '';
  });

  // Menu "+ Nueva": Coleccion o Carpeta
  document.getElementById('btnNewCollection').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('newMenu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
    menu.classList.toggle('show');
  });

  document.getElementById('menuNewCollection').addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewMenu();
    const name = prompt('Nombre del nuevo grupo:');
    if (!name) return;
    const spaceId = genId('sp');
    state.spaces.push({ id: spaceId, name: name.trim(), color: nextColor(state.spaces.length) });
    save(); render();
    toast('Grupo creado');
  });

  document.getElementById('menuNewFolder').addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewMenu();
    const colId = state.ui.selectedCollection;
    if (!colId) {
      toast('Primero selecciona una coleccion');
      return;
    }
    promptNewFolder(colId);
  });

  // Cerrar el menu al hacer click fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#newMenu') && !e.target.closest('#btnNewCollection')) {
      closeNewMenu();
    }
  });

  // Ajustes
  document.getElementById('btnSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.add('show');
    const gh = state.settings.gh;
    document.getElementById('ghUser').value = gh.user || '';
    document.getElementById('ghRepo').value = gh.repo || '';
    document.getElementById('ghToken').value = gh.token || '';
    document.getElementById('ghBranch').value = gh.branch || 'main';
  });
  document.getElementById('btnCloseSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('show');
  });

  // Guardar config de GitHub al hacer push/pull
  async function saveGhConfig() {
    state.settings.gh = {
      user: document.getElementById('ghUser').value.trim(),
      repo: document.getElementById('ghRepo').value.trim(),
      token: document.getElementById('ghToken').value.trim(),
      branch: document.getElementById('ghBranch').value.trim() || 'main'
    };
    await save();
  }

  document.getElementById('btnPush').addEventListener('click', async () => {
    await saveGhConfig(); ghPush();
  });
  document.getElementById('btnPull').addEventListener('click', async () => {
    await saveGhConfig(); ghPull();
  });

  document.getElementById('btnExportSettings').addEventListener('click', exportData);
  document.getElementById('btnImportSettings').addEventListener('click', pickFile);

  document.getElementById('btnWipe').addEventListener('click', async () => {
    if (!confirm('Esto borra TODO. Incluye los datos guardados en GitHub si luego haces pull. Continuar?')) return;
    if (!confirm('Seguro? No se puede deshacer.')) return;
    state = { spaces: [], collections: [], bookmarks: {}, settings: state.settings, ui: { search: '', selectedCollection: null } };
    await save(); render();
    toast('Todo borrado');
  });

  // Fondo
  document.getElementById('bgUpload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      state.settings.bgImage = reader.result;
      applyBackground();
      await save();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('btnClearBg').addEventListener('click', async () => {
    state.settings.bgImage = null;
    applyBackground();
    await save();
  });

  // Atajos de teclado
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.body.classList.contains('zen-on')) { toggleZen(false); return; }
      if (document.getElementById('settingsModal').classList.contains('show')) {
        document.getElementById('settingsModal').classList.remove('show'); return;
      }
      // Si hay busqueda, limpiarla
      if (state.ui.search) {
        state.ui.search = '';
        document.getElementById('search').value = '';
        render();
      }
    }
    // Ctrl+K -> foco en busqueda
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });

  // Panoramica y zoom del canvas
  setupCanvasPanZoom();
}

/* ---- Pan/zoom del canvas ---- */
function setupCanvasPanZoom() {
  const svg = document.getElementById('canvas');
  let scale = 1, panX = 0, panY = 0;
  let dragging = false, startX = 0, startY = 0;

  function applyTransform() {
    svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    svg.style.transformOrigin = 'center center';
  }

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.3, Math.min(3, scale * factor));
    applyTransform();
  }, { passive: false });

  svg.addEventListener('mousedown', e => {
    // Solo pan si hace click en el fondo, no en un nodo
    if (e.target.closest('.node')) return;
    dragging = true;
    svg.classList.add('dragging');
    startX = e.clientX - panX;
    startY = e.clientY - panY;
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    svg.classList.remove('dragging');
  });

  document.getElementById('zoomIn').addEventListener('click', () => { scale = Math.min(3, scale * 1.2); applyTransform(); });
  document.getElementById('zoomOut').addEventListener('click', () => { scale = Math.max(0.3, scale / 1.2); applyTransform(); });
  document.getElementById('zoomFit').addEventListener('click', () => { scale = 1; panX = 0; panY = 0; applyTransform(); });
}

/* ================================================================
   INICIO
   ================================================================ */
(async function init() {
  await load();
  bindEvents();
  render();
  loadOpenTabs();
})();