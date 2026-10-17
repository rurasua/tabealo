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

   offices     = [{ id, name, color, shared }]        OFICINAS
   spaces      = [{ id, officeId, name, color }]      DEPARTAMENTOS
   collections = [{ id, spaceId, name, bookmarks }]   ESCRITORIOS
   bookmarks   = { id: { title, url, icon, note } }

   Jerarquia: Oficina > Departamento > Escritorio > Bookmark
   El usuario le pone a cada Escritorio el nombre que quiera.
*/
let state = {
  offices: [],
  spaces: [],
  collections: [],
  bookmarks: {},
  settings: { theme: 'light', view: 'board', bgImage: null, gh: { user:'', repo:'', token:'', branch:'main' } },
  ui: { search: '', selectedCollection: null, selectedOffice: null, selectedSpace: null }
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
   Los grupos de Toby se convierten en DEPARTAMENTOS de una sola Oficina.
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

  state.offices = [];
  state.spaces = [];
  state.collections = [];
  state.bookmarks = {};

  const deptColors = ['#f65077','#4a90e2','#1a9e4b','#f0a020','#9b59b6','#e0563a','#00a5a5','#d94f8a'];

  // Todo lo importado de Toby cabe en una sola Oficina.
  const officeId = genId('of');
  state.offices.push({
    id: officeId,
    name: 'Importado de Toby',
    color: '#4a90e2',
    shared: false
  });

  for (const group of json.groups) {
    const spaceId = genId('sp');
    state.spaces.push({
      id: spaceId,
      officeId,
      name: group.name || 'Sin nombre',
      color: deptColors[state.spaces.length % deptColors.length]
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
        position: state.collections.length
      });
    }
  }

  sortCollections();
  return true;
}

/* Ordena los Escritorios por nombre dentro de cada Departamento */
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
   #texto    -> solo escritorios
   %texto    -> global (todos los escritorios)
   ?texto    -> buscar en Google
   !texto    -> preguntar a ChatGPT
   @tag      -> enlaces con ese tag
   a|b       -> OR
   texto     -> enlaces dentro del escritorio seleccionado
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
  // @nota texto busca SOLO dentro de las notas. Cualquier otro @ es un tag.
  if (t.startsWith('@')) {
    const resto = t.slice(1);
    if (/^nota\b/.test(resto)) {
      return { type: 'note', term: resto.slice(4).trim().toLowerCase() };
    }
    return { type: 'tag', term: resto.toLowerCase() };
  }
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

  // Busqueda dentro de los enlaces
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

  // Los demas operadores matchean por nombre de escritorio o por tag
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

    // @nota busca solo dentro del texto de las notas
    if (q.type === 'note') {
      if (!q.term) continue;
      const hits = col.bookmarks
        .map(id => state.bookmarks[id])
        .filter(b => b && (b.note || '').toLowerCase().includes(q.term));
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
      const count = r.bookmarks ? r.bookmarks.length : colTotal(r.collection);
      return `<div class="collection-item" data-col="${r.collection.id}">
        <span class="col-icon">🖥️</span>
        <span class="col-name">${esc(r.collection.name)}</span>
        <span class="col-count">${count}</span>
      </div>`;
    }).join('');
    document.getElementById('stats').textContent =
      results.length + (results.length === 1 ? ' escritorio' : ' escritorios');
    bindSidebar();
    return;
  }

  // Vista normal: oficinas > departamentos > escritorios
  const totalBm = Object.keys(state.bookmarks).length;
  document.getElementById('stats').textContent =
    `${state.offices.length} oficinas · ${state.spaces.length} departamentos · ${state.collections.length} escritorios · ${totalBm} enlaces`;

  if (state.offices.length === 0) {
    list.innerHTML = `
      <div class="cc-empty">
        Todavia no hay oficinas.<br>
        Crea una para empezar a organizar tus marcadores.
      </div>`;
    return;
  }

  list.innerHTML = state.offices.map(office => {
    const depts = state.spaces.filter(s => s.officeId === office.id);
    return `
      <div class="office ${office.id === state.ui.selectedOffice ? 'open' : ''}" data-office="${office.id}">
        <div class="office-header">
          <span class="office-chevron">▶</span>
          <span class="office-name">${esc(office.name)}</span>
          <span class="office-tag">${office.shared ? 'compartida' : 'privada'}</span>
          <span class="office-count">${depts.length}</span>
          <button class="office-add-dept" data-act="add-department" data-office="${office.id}" title="Nuevo departamento">+</button>
          <button class="office-del" data-act="delete-office" data-office="${office.id}" title="Eliminar oficina">🗑</button>
        </div>
        <div class="office-body">
          ${depts.length === 0
            ? '<div class="dept-empty">Sin departamentos</div>'
            : depts.map(space => {
                const cols = state.collections.filter(c => c.spaceId === space.id);
                const total = cols.reduce((n, c) => n + colTotal(c), 0);
                // El Departamento se ve desplegado si es el seleccionado
                const abierto = space.id === state.ui.selectedSpace;
                return `
                <div class="space ${abierto ? 'open' : ''}" data-space="${space.id}">
                  <div class="space-header">
                    <span class="space-chevron">▶</span>
                    <span class="space-dot" style="background:${space.color}"></span>
                    <span class="space-name">${esc(space.name)}</span>
                    <span class="space-count">${total}</span>
                    <button class="space-add" data-act="add-collection" data-space="${space.id}" title="Nuevo escritorio">+</button>
                    <button class="space-del" data-act="delete-department" data-space="${space.id}" title="Eliminar departamento">🗑</button>
                  </div>
                  <div class="space-collections">
                    ${cols.map(col => `
                      <div class="collection-item ${col.id === state.ui.selectedCollection ? 'active' : ''}" data-col="${col.id}">
                        <span class="col-icon">🖥️</span>
                        <span class="col-name">${esc(col.name)}</span>
                        <span class="col-count">${colTotal(col)}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>`;
              }).join('')}
        </div>
      </div>`;
  }).join('');

  list.insertAdjacentHTML('beforeend', `
    <button class="new-office" data-act="new-office">
      <span>+</span> Nueva Oficina
    </button>`);

  bindSidebar();
}

/* Total de enlaces de un Escritorio.
   Cada enlace vive directo en su Escritorio, sin carpetas intermedias. */
function colTotal(col) {
  return (col.bookmarks || []).length;
}

function bindSidebar() {
  // Encabezado de Oficina: despliega / repliega
  document.querySelectorAll('.office-header').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.closest('.office-add-dept')) return;
      if (e.target.closest('.office-del')) return;
      const of = h.parentElement;
      const id = of.dataset.office;
      const abriendo = !of.classList.contains('open');
      of.classList.toggle('open', abriendo);
      state.ui.selectedOffice = abriendo ? id : null;
      if (abriendo) {
        // Al abrir una Oficina se despliega su primer Departamento
        const primerDept = of.querySelector('.space');
        if (primerDept && !of.querySelector('.space.open')) {
          primerDept.classList.add('open');
          state.ui.selectedSpace = primerDept.dataset.space;
        }
      }
      save();
    });
  });

  // Boton + de cada Oficina: crear Departamento
  document.querySelectorAll('#sidebarList .office-add-dept').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const officeId = btn.dataset.office;
      const office = state.offices.find(o => o.id === officeId);
      const name = prompt(`Nombre del nuevo departamento en "${office ? office.name : ''}":`);
      if (!name) return;
      const spaceId = genId('sp');
      state.spaces.push({
        id: spaceId,
        officeId,
        name: name.trim(),
        color: nextColor(state.spaces.length)
      });
      btn.closest('.office')?.classList.add('open');
      state.ui.selectedOffice = officeId;
      save(); render();
      toast('Departamento creado');
    });
  });

  // Encabezado de Departamento: despliega / replega sus Escritorios
  document.querySelectorAll('#sidebarList .space-header').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.closest('.space-add')) return;
      if (e.target.closest('.space-del')) return;
      const sp = h.parentElement;
      const id = sp.dataset.space;
      const abriendo = !sp.classList.contains('open');
      sp.classList.toggle('open', abriendo);
      state.ui.selectedSpace = abriendo ? id : null;
      const office = sp.closest('.office');
      if (office && abriendo) {
        office.classList.add('open');
        state.ui.selectedOffice = office.dataset.office;
      }
      save();
    });
  });

  // Boton + de cada Departamento: crear Escritorio
  document.querySelectorAll('#sidebarList .space-add').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const spaceId = btn.dataset.space;
      const space = state.spaces.find(s => s.id === spaceId);
      const name = prompt(`Nombre del nuevo escritorio en "${space ? space.name : ''}":`);
      if (!name || !name.trim()) return;
      createDesktop(spaceId, name.trim());
      // Abrir la oficina y el departamento para que se vea recien creado
      const office = btn.closest('.office');
      office?.classList.add('open');
      state.ui.selectedOffice = office?.dataset.office || null;
      state.ui.selectedSpace = spaceId;
      save(); render();
      toast('Escritorio creado');
    });
  });

  // Boton de papelera de cada Oficina: eliminarla con todo su contenido
  document.querySelectorAll('#sidebarList .office-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteOffice(btn.dataset.office);
    });
  });

  // Boton de papelera de cada Departamento
  document.querySelectorAll('#sidebarList .space-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteDepartment(btn.dataset.space);
    });
  });

  // Escritorios: seleccionar
  document.querySelectorAll('#sidebarList .collection-item[data-col]').forEach(c => {
    c.addEventListener('click', () => {
      state.ui.selectedCollection = c.dataset.col;
      // Abrir la oficina y el departamento del escritorio elegido
      const office = c.closest('.office');
      if (office) { office.classList.add('open'); state.ui.selectedOffice = office.dataset.office; }
      const space = c.closest('.space');
      if (space) {
        space.classList.add('open');
        state.ui.selectedSpace = space.dataset.space;
      }
      // Cerrar los demas Departamentos para no saturar el panel
      c.closest('.office')?.querySelectorAll('.space.open').forEach(s => {
        if (s !== space) s.classList.remove('open');
      });
      render();
    });
    // Arrastrar pestanas abiertas sobre el escritorio
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

  // Boton final: crear una Oficina nueva
  const newOfficeBtn = document.querySelector('#sidebarList .new-office');
  if (newOfficeBtn) newOfficeBtn.addEventListener('click', () => createOffice());
}

/* ---- TABLERO ---- */

/* Notas desplegadas y nota en edicion.
   Son estado de VISTA, no del usuario: no se guardan en storage, asi que
   al recargar la pagina todo vuelve a su estado normal. */
const notasAbiertas = new Set();
let notaEnEdicion = null;

function renderBoard() {
  const q = state.ui.search.trim();
  const board = document.getElementById('board');

  let collectionsToShow = state.collections;
  if (state.ui.selectedCollection) {
    collectionsToShow = state.collections.filter(c => c.id === state.ui.selectedCollection);
  }

  // Cuando hay busqueda guardamos WHICH enlaces coincidieron en cada
  // Escritorio, para no mostrar los otros 1,269 de un solo Escritorio.
  let hitsPorCol = null;
  if (q) {
    const res = searchResults(q);
    collectionsToShow = res.map(r => r.collection);
    hitsPorCol = new Map();
    res.forEach(r => {
      if (r.bookmarks) hitsPorCol.set(r.collection.id, new Set(r.bookmarks.map(b => b.id)));
    });
  }

  // Al buscar con @nota las notas se abren solas: si no, no se ve
  // POR QUE aparecio el enlace en los resultados.
  const abrirNotas = /^@nota\b/i.test(q);

  if (collectionsToShow.length === 0) {
    board.innerHTML = '';
    return;
  }

  board.innerHTML = collectionsToShow.map(col => {
    const space = state.spaces.find(s => s.id === col.spaceId);
    let bms = (col.bookmarks || []).map(id => state.bookmarks[id]).filter(Boolean);

    // En busqueda, quedate solo con los enlaces que coincidieron
    if (hitsPorCol && hitsPorCol.has(col.id)) {
      const set = hitsPorCol.get(col.id);
      bms = bms.filter(b => set.has(b.id));
    }

    // Cada enlace ocupa TRES bloques: su fila, el panel de la nota
    // desplegada y el editor para escribirla. Van juntos para que la nota
    // aparezca justo debajo de la fila que le pertenece.
    const rowHtml = (bm) => {
      const nota = (bm.note || '').trim();
      const abierta = abrirNotas || notasAbiertas.has(bm.id);
      const editando = notaEnEdicion === bm.id;
      return `
      <div class="bm-row" data-bm="${bm.id}" data-url="${esc(bm.url)}" draggable="true">
        <img class="bm-icon" src="${esc(bm.icon)}" onerror="this.style.visibility='hidden'" alt="">
        <div class="bm-text">
          <div class="bm-title">${esc(bm.title)}</div>
          <div class="bm-url">${esc(bm.url.replace(/^https?:\/\//, '').slice(0, 60))}</div>
        </div>
        ${nota
          ? `<button class="bm-note-toggle ${abierta ? 'open' : ''}" data-act="toggle-note" data-bm="${bm.id}" title="Mostrar u ocultar la nota">
               <span class="caret">▶</span> Notas
             </button>`
          : ''}
        <div class="bm-tools">
          <button class="icon-btn bm-note-btn ${nota ? 'has-note' : ''}" data-act="edit-note" data-bm="${bm.id}" title="Añadir nota">🗒</button>
          <button class="icon-btn bm-edit" data-act="edit-bm" data-bm="${bm.id}" title="Renombrar">✎</button>
          <button class="icon-btn bm-del" data-act="delete-bm" data-bm="${bm.id}" title="Eliminar">✕</button>
        </div>
      </div>
      ${nota
        ? `<div class="bm-note-panel ${abierta ? 'open' : ''}">
             <div class="bm-note-text">${esc(nota)}</div>
           </div>`
        : ''}
      <div class="bm-note-editor ${editando ? 'open' : ''}">
        <textarea data-note-ta="${bm.id}" placeholder="Escribe tu nota aqui...">${esc(nota)}</textarea>
        <div class="bm-note-actions">
          <span class="hint">Ctrl+Enter para guardar · Escape para cancelar</span>
          <button class="btn btn-sm" data-act="cancel-note" data-bm="${bm.id}">Cancelar</button>
          <button class="btn btn-sm btn-primary" data-act="save-note" data-bm="${bm.id}">Guardar</button>
        </div>
      </div>`;
    };

    const contentHtml = bms.length
      ? bms.map(bm => rowHtml(bm)).join('')
      : '<div class="cc-empty">Sin enlaces</div>';

    return `
      <div class="collection-card" data-col="${col.id}">
        <div class="cc-header">
          <span class="cc-space-dot" style="background:${space ? space.color : '#888'}"></span>
          <div style="flex:1;min-width:0">
            <div class="cc-title">${esc(col.name)}</div>
            <div class="cc-space">${esc(space ? space.name : '')}</div>
          </div>
          <div class="cc-actions">
            <button class="icon-btn" data-act="open-group" data-col="${col.id}" title="Abrir como grupo de pestañas">⊞</button>
            <button class="icon-btn" data-act="delete-col" data-col="${col.id}" title="Eliminar escritorio">🗑</button>
          </div>
        </div>
        <div class="cc-list">
          ${contentHtml}
        </div>
        <div class="cc-footer">
          <span class="cc-meta">${bms.length} ${bms.length === 1 ? 'enlace' : 'enlaces'}</span>
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
    // Arrastrar bookmark a otro escritorio
    r.addEventListener('dragstart', e => {
      r.classList.add('dragging');
      e.dataTransfer.setData('text/bookmark-id', r.dataset.bm);
    });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
  });

  // Cards aceptan drop
  document.querySelectorAll('#board .collection-card').forEach(card => {
    card.addEventListener('dragover', e => {
      e.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', e => {
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

      if (act === 'delete-bm') deleteBookmark(bmId);
      if (act === 'edit-bm') startEditTitle(bmId);
      if (act === 'edit-note') startEditNote(bmId);
      if (act === 'save-note') saveNote(bmId);
      if (act === 'cancel-note') cancelNote();
      if (act === 'toggle-note') toggleNote(bmId);
      if (act === 'delete-col') deleteCollection(colId);
      if (act === 'open-group') openCollectionAsGroup(colId);
      if (act === 'open-all') openCollectionAsGroup(colId);
    });
  });

  /* Atajos del editor de nota: Ctrl+Enter guarda, Escape cancela.
     Van aparte porque el keydown general de la app usa Escape para limpiar
     la busqueda, y aqui Escape debe cerrar solo el editor. */
  document.querySelectorAll('#board [data-note-ta]').forEach(ta => {
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveNote(ta.dataset.noteTa);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelNote();
      }
    });
  });
}

/* ---- NOTAS ---- */
function startEditNote(bmId) {
  notaEnEdicion = bmId;
  render();
  const ta = document.querySelector(`#board [data-note-ta="${bmId}"]`);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function saveNote(bmId) {
  const ta = document.querySelector(`#board [data-note-ta="${bmId}"]`);
  const bm = state.bookmarks[bmId];
  if (!ta || !bm) { notaEnEdicion = null; return; }

  const nota = ta.value.trim();
  bm.note = nota;
  notaEnEdicion = null;

  // Al guardar, la nota se muestra de una vez para que veas lo que quedo
  if (nota) notasAbiertas.add(bmId);
  else notasAbiertas.delete(bmId);

  save();
  render();
  toast(nota ? 'Nota guardada' : 'Nota borrada');
}

function cancelNote() {
  notaEnEdicion = null;
  render();
}

function toggleNote(bmId) {
  if (notasAbiertas.has(bmId)) notasAbiertas.delete(bmId);
  else notasAbiertas.add(bmId);
  render();
}

/* ---- CANVAS (mapa visual con drill-down) ----
   Con 182 Escritorios un mapa radial de una sola vez resulta ilegible:
   todos los nombres se enciman. Por eso baja por niveles:
     nivel 1 = las Oficinas
     nivel 2 = los Departamentos de UNA Oficina
     nivel 3 = los Escritorios de UN Departamento
   Click en un Escritorio lo selecciona y vuelve al tablero. */
let canvasLevel = 'offices';
let canvasOffice = null;
let canvasSpace = null;

function renderCanvas() {
  const svg = document.getElementById('canvas');
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) * 0.36;

  let html = '';

  // Boton de volver, segun el nivel actual
  if (canvasLevel === 'departments') {
    html += `<text x="${cx}" y="34" text-anchor="middle" fill="var(--fg-muted)" font-size="12" style="cursor:pointer" id="canvasBack">volver a todas las oficinas</text>`;
  } else if (canvasLevel === 'desktops') {
    html += `<text x="${cx}" y="34" text-anchor="middle" fill="var(--fg-muted)" font-size="12" style="cursor:pointer" id="canvasBack">volver a los departamentos</text>`;
  }

  if (canvasLevel === 'offices') {
    // NIVEL 1: Oficinas
    const n = state.offices.length || 1;
    state.offices.forEach((office, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const depts = state.spaces.filter(s => s.officeId === office.id);
      const desks = state.collections.filter(c => depts.some(d => d.id === c.spaceId));
      const links = desks.reduce((acc, c) => acc + colTotal(c), 0);
      const r = Math.min(56, 24 + depts.length * 0.9);

      html += `<line class="edge" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" opacity="0.5"/>`;
      // El nombre va debajo del circulo: dentro se cortaria muy pronto
      html += `<g class="node" data-office="${office.id}" style="cursor:pointer">
        <circle cx="${x}" cy="${y}" r="${r}" fill="${office.color || '#4a90e2'}" opacity="0.92"/>
        <text x="${x}" y="${y - 1}" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">${esc(office.name.slice(0, 10))}</text>
        <text x="${x}" y="${y + 11}" text-anchor="middle" fill="#fff" font-size="8" opacity="0.85">${depts.length} dep · ${desks.length} esc</text>
        <text x="${x}" y="${y + r + 14}" text-anchor="middle" fill="var(--fg)" font-size="10" font-weight="600">${esc(office.name)}</text>
        <text x="${x}" y="${y + r + 26}" text-anchor="middle" fill="var(--fg-muted)" font-size="8">${links} enlaces</text>
      </g>`;
    });

    html += `<g>
      <circle cx="${cx}" cy="${cy}" r="34" fill="var(--accent)" opacity="0.15"/>
      <circle cx="${cx}" cy="${cy}" r="24" fill="var(--accent)"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${state.collections.length} esc</text>
    </g>`;
  } else if (canvasLevel === 'departments') {
    // NIVEL 2: Departamentos de la Oficina abierta
    const office = state.offices.find(o => o.id === canvasOffice);
    const depts = state.spaces.filter(s => s.officeId === canvasOffice);
    const n = depts.length || 1;
    const twoRings = n > 18;
    const firstRing = twoRings ? Math.ceil(n / 2) : n;

    html += `<text x="${cx}" y="${cy - radius * 0.95}" text-anchor="middle" fill="var(--fg)" font-size="16" font-weight="600">${esc(office ? office.name : '')}</text>`;

    depts.forEach((space, i) => {
      const onSecond = twoRings && i >= firstRing;
      const idx = onSecond ? i - firstRing : i;
      const ringN = onSecond ? n - firstRing : firstRing;
      const rr = onSecond ? radius : radius * 0.7;
      const angle = (idx / Math.max(ringN, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * rr;
      const y = cy + Math.sin(angle) * rr;
      const desks = state.collections.filter(c => c.spaceId === space.id);
      const links = desks.reduce((acc, c) => acc + colTotal(c), 0);

      html += `<line class="edge" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" opacity="0.3"/>`;
      html += `<g class="node" data-space="${space.id}" style="cursor:pointer">
        <circle cx="${x}" cy="${y}" r="7" fill="${space.color}"/>
        <text x="${x}" y="${y - 13}" text-anchor="middle" fill="var(--fg)" font-size="9" opacity="0.92">${esc(space.name.slice(0, 20))}</text>
        <text x="${x}" y="${y + 19}" text-anchor="middle" fill="var(--fg-muted)" font-size="7.5">${desks.length} esc · ${links}</text>
      </g>`;
    });

    html += `<g>
      <circle cx="${cx}" cy="${cy}" r="28" fill="var(--accent)" opacity="0.15"/>
      <circle cx="${cx}" cy="${cy}" r="20" fill="var(--accent)"/>
    </g>`;
  } else {
    // NIVEL 3: Escritorios del Departamento abierto
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
      const rr = onSecond ? radius : radius * 0.66;
      const angle = (idx / Math.max(ringN, 1)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * rr;
      const y = cy + Math.sin(angle) * rr;

      html += `<line class="edge" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" opacity="0.3"/>`;
      html += `<g class="node" data-col="${col.id}" style="cursor:pointer">
        <circle cx="${x}" cy="${y}" r="6" fill="${space ? space.color : '#888'}"/>
        <text x="${x}" y="${y - 12}" text-anchor="middle" fill="var(--fg)" font-size="9" opacity="0.92">${esc(col.name.slice(0, 20))}</text>
        <text x="${x}" y="${y + 18}" text-anchor="middle" fill="var(--fg-muted)" font-size="7.5">${colTotal(col)}</text>
      </g>`;
    });

    html += `<g>
      <circle cx="${cx}" cy="${cy}" r="28" fill="var(--accent)" opacity="0.15"/>
      <circle cx="${cx}" cy="${cy}" r="20" fill="var(--accent)"/>
    </g>`;
  }

  svg.innerHTML = html;

  // Nivel 1 -> 2
  svg.querySelectorAll('[data-office]').forEach(g => {
    g.addEventListener('click', () => {
      canvasLevel = 'departments';
      canvasOffice = g.dataset.office;
      renderCanvas();
    });
  });

  // Nivel 2 -> 3
  svg.querySelectorAll('[data-space]').forEach(g => {
    g.addEventListener('click', () => {
      canvasLevel = 'desktops';
      canvasSpace = g.dataset.space;
      renderCanvas();
    });
  });

  // Nivel 3 -> tablero
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
      if (canvasLevel === 'desktops') {
        canvasLevel = 'departments';
        canvasSpace = null;
      } else {
        canvasLevel = 'offices';
        canvasOffice = null;
      }
      renderCanvas();
    });
  }
}

/* ================================================================
   ACCIONES
   ================================================================ */
/* Quita un enlace de donde este, para poder moverlo a otro Escritorio */
function detachBookmark(bmId) {
  for (const col of state.collections) {
    col.bookmarks = (col.bookmarks || []).filter(id => id !== bmId);
  }
}

/* Todos los enlaces de un Escritorio */
function allBookmarksOf(col) {
  return (col.bookmarks || []).map(id => state.bookmarks[id]).filter(Boolean);
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
  if (!confirm('¿Eliminar este escritorio y sus enlaces?')) return;
  const col = state.collections.find(c => c.id === colId);
  if (col) allBookmarksOf(col).forEach(bm => delete state.bookmarks[bm.id]);
  state.collections = state.collections.filter(c => c.id !== colId);
  if (state.ui.selectedCollection === colId) {
    state.ui.selectedCollection = null;
  }
  save(); render();
}

/* CuentaDepartamentos, Escritorios y enlaces que hay bajo un Departamento */
function countOfDepartment(spaceId) {
  const cols = state.collections.filter(c => c.spaceId === spaceId);
  return {
    escritorios: cols.length,
    enlaces: cols.reduce((n, c) => n + colTotal(c), 0)
  };
}

/* Cuenta lo que hay bajo una Oficina */
function countOfOffice(officeId) {
  const depts = state.spaces.filter(s => s.officeId === officeId);
  const cuentas = depts.map(d => countOfDepartment(d.id));
  return {
    departamentos: depts.length,
    escritorios: cuentas.reduce((n, c) => n + c.escritorios, 0),
    enlaces: cuentas.reduce((n, c) => n + c.enlaces, 0)
  };
}

/* Escribe "3 departamentos, 5 escritorios y 12 enlaces" para el confirm */
function describeCounts(c) {
  const partes = [];
  if (c.departamentos) partes.push(`${c.departamentos} ${c.departamentos === 1 ? 'departamento' : 'departamentos'}`);
  if (c.escritorios) partes.push(`${c.escritorios} ${c.escritorios === 1 ? 'escritorio' : 'escritorios'}`);
  if (c.enlaces) partes.push(`${c.enlaces} ${c.enlaces === 1 ? 'enlace' : 'enlaces'}`);
  if (partes.length <= 1) return partes.join('');
  return partes.slice(0, -1).join(', ') + ' y ' + partes[partes.length - 1];
}

/* Elimina un Departamento con todos sus Escritorios y enlaces */
function deleteDepartment(spaceId) {
  const space = state.spaces.find(s => s.id === spaceId);
  if (!space) return;
  const c = countOfDepartment(spaceId);

  // Sin contenido no hace falta preguntar nada
  if (c.escritorios > 0) {
    const detalle = describeCounts(c);
    if (!confirm(`¿Eliminar el departamento "${space.name}"?\n\nTambién se borran ${detalle}.\nNo se puede deshacer.`)) return;
  } else if (!confirm(`¿Eliminar el departamento "${space.name}"?`)) return;

  const cols = state.collections.filter(x => x.spaceId === spaceId);
  cols.forEach(col => allBookmarksOf(col).forEach(bm => delete state.bookmarks[bm.id]));
  state.collections = state.collections.filter(x => x.spaceId !== spaceId);
  state.spaces = state.spaces.filter(s => s.id !== spaceId);

  if (state.ui.selectedSpace === spaceId) state.ui.selectedSpace = null;
  if (cols.some(x => x.id === state.ui.selectedCollection)) state.ui.selectedCollection = null;

  save(); render();
  toast('Departamento eliminado');
}

/* Elimina una Oficina con todos sus Departamentos, Escritorios y enlaces */
function deleteOffice(officeId) {
  const office = state.offices.find(o => o.id === officeId);
  if (!office) return;
  const c = countOfOffice(officeId);

  if (c.departamentos > 0) {
    const detalle = describeCounts(c);
    if (!confirm(`¿Eliminar la oficina "${office.name}"?\n\nTambién se borran ${detalle}.\nNo se puede deshacer.`)) return;
  } else if (!confirm(`¿Eliminar la oficina "${office.name}"?`)) return;

  const depts = state.spaces.filter(s => s.officeId === officeId);
  const deptIds = new Set(depts.map(d => d.id));
  const cols = state.collections.filter(x => deptIds.has(x.spaceId));
  cols.forEach(col => allBookmarksOf(col).forEach(bm => delete state.bookmarks[bm.id]));

  state.collections = state.collections.filter(x => !deptIds.has(x.spaceId));
  state.spaces = state.spaces.filter(s => s.officeId !== officeId);
  state.offices = state.offices.filter(o => o.id !== officeId);

  if (state.ui.selectedOffice === officeId) state.ui.selectedOffice = null;
  if (depts.some(d => d.id === state.ui.selectedSpace)) state.ui.selectedSpace = null;
  if (cols.some(x => x.id === state.ui.selectedCollection)) state.ui.selectedCollection = null;

  save(); render();
  toast('Oficina eliminada');
}

/* Paleta de circulos para Escritorios y Departamentos */
const COLLECTION_COLORS = [
  '#e0563a', '#4a90e2', '#1a9e4b', '#f0a020', '#9b59b6', '#00a5a5',
  '#d94f8a', '#c0392b', '#16a085', '#8e44ad', '#d35400', '#27ae60'
];

function nextColor(index) {
  return COLLECTION_COLORS[index % COLLECTION_COLORS.length];
}

/* Crea un Escritorio dentro de un Departamento */
function createDesktop(spaceId, nombre) {
  const colId = genId('col');
  state.collections.push({
    id: colId,
    spaceId,
    name: nombre,
    color: nextColor(state.collections.length),
    bookmarks: [],
    position: state.collections.length
  });
  state.ui.selectedCollection = colId;
  return colId;
}

function moveBookmark(bmId, toColId) {
  detachBookmark(bmId);
  const dest = state.collections.find(c => c.id === toColId);
  if (dest) dest.bookmarks.push(bmId);
  save(); render();
  toast('Bookmark movido');
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

/* Reabre un Escritorio como grupo de pestanas de Chrome */
async function openCollectionAsGroup(colId) {
  const col = state.collections.find(c => c.id === colId);
  if (!col) return;

  const bms = allBookmarksOf(col);
  if (bms.length === 0) { toast('Ese escritorio no tiene enlaces'); return; }

  const urls = bms.map(b => b.url);
  const tabIds = await chrome.tabs.create({ url: urls, active: false });

  // Agrupar si el navegador lo soporta
  try {
    await chrome.tabs.group({ tabIds, groupId: -1 });
    await chrome.tabGroups.update(-1, { title: col.name, color: 'blue' });
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

  // Arrastrar pestana abierta a un Escritorio / click para enfocarla
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

/* Captura la ventana actual como un Escritorio nuevo */
async function captureWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const valid = tabs.filter(t => t.url.startsWith('http'));
  if (valid.length === 0) { toast('No hay pestanas web abiertas'); return; }

  // Necesita un Departamento donde dejar el Escritorio
  let spaceId = state.ui.selectedSpace;
  if (!spaceId && state.spaces.length === 0) {
    toast('Primero crea una Oficina y un Departamento');
    return;
  }
  if (!spaceId) spaceId = state.spaces[0].id;

  const space = state.spaces.find(s => s.id === spaceId);
  const name = prompt(
    `Nombre del escritorio en "${space ? space.name : ''}":`,
    'Sesión ' + new Date().toLocaleDateString('es')
  );
  if (!name || !name.trim()) return;

  const bmIds = [];
  for (const t of valid) {
    const bmId = genId('bm');
    state.bookmarks[bmId] = { id: bmId, title: t.title || t.url, url: t.url, icon: t.favIconUrl || '', note: '', tags: [] };
    bmIds.push(bmId);
  }

  const colId = createDesktop(spaceId, name.trim());
  const col = state.collections.find(c => c.id === colId);
  col.bookmarks = bmIds;

  save(); render();
  toast(`${valid.length} pestañas capturadas`);
}

/* Crea una Oficina nueva con su primer Departamento listo.
   Si el usuario cancela el nombre, no se crea nada. */
function createOffice() {
  const nombre = prompt('Nombre de la nueva Oficina:');
  if (!nombre || !nombre.trim()) return null;

  const officeId = genId('of');
  state.offices.push({
    id: officeId,
    name: nombre.trim(),
    color: '#4a90e2',
    shared: false
  });

  const spaceId = genId('sp');
  state.spaces.push({
    id: spaceId,
    officeId,
    name: 'General',
    color: nextColor(state.spaces.length)
  });

  state.ui.selectedOffice = officeId;
  save(); render();
  toast('Oficina creada');
  return officeId;
}

/* Crea un Departamento dentro de una Oficina */
function createDepartment(officeId) {
  const office = state.offices.find(o => o.id === officeId);
  const nombre = prompt(`Nombre del nuevo departamento en "${office ? office.name : ''}":`);
  if (!nombre || !nombre.trim()) return null;

  const spaceId = genId('sp');
  state.spaces.push({
    id: spaceId,
    officeId,
    name: nombre.trim(),
    color: nextColor(state.spaces.length)
  });
  state.ui.selectedOffice = officeId;
  save(); render();
  toast('Departamento creado');
  return spaceId;
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
      toast(`Importados ${state.spaces.length} departamentos · ${state.collections.length} escritorios · ${n} enlaces`);
    }
    e.target.value = '';
  });

  // Menu "+ Nueva": Oficina, Departamento o Escritorio
  document.getElementById('btnNewCollection').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('newMenu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 6) + 'px';
    menu.classList.toggle('show');
  });

  document.getElementById('menuNewOffice').addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewMenu();
    createOffice();
  });

  document.getElementById('menuNewCollection').addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewMenu();
    if (state.offices.length === 0) {
      toast('Primero crea una Oficina');
      return;
    }
    // Se anade a la Oficina seleccionada, o a la primera si no hay ninguna abierta
    const officeId = state.ui.selectedOffice || state.offices[0].id;
    createDepartment(officeId);
  });

  document.getElementById('menuNewDesktop').addEventListener('click', (e) => {
    e.stopPropagation();
    closeNewMenu();
    let spaceId = state.ui.selectedSpace;
    if (!spaceId) {
      toast('Primero selecciona un Departamento');
      return;
    }
    const space = state.spaces.find(s => s.id === spaceId);
    const name = prompt(`Nombre del nuevo escritorio en "${space ? space.name : ''}":`);
    if (!name || !name.trim()) return;
    createDesktop(spaceId, name.trim());
    save(); render();
    toast('Escritorio creado');
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
    state = {
      offices: [],
      spaces: [],
      collections: [],
      bookmarks: {},
      settings: state.settings,
      ui: { search: '', selectedCollection: null, selectedOffice: null, selectedSpace: null }
    };
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