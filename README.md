# TabVault

Gestor de pestañas y bookmarks. **Tus datos en tu máquina, sin servidor, sin cuenta, sin cobros.**

Inspirado en la idea de TheTab.Ninja y en las funcionalidades de Toby, pero con código propio y sin dependencias externas.

---

## Qué hace

- **Importa el export JSON de Toby** (soporta v4): tus 22 espacios, 182 colecciones y 1,270 bookmarks entran en un click.
- **Panel de pestañas abiertas**: arrastra cualquier pestaña abierta a una colección y se guarda.
- **Capturar ventana completa**: convierte todo lo que tienes abierto en una colección nueva.
- **Reabrir colección como grupo de pestañas** de Chrome.
- **Búsqueda con operadores** (ver abajo).
- **Vista tablero** (grid) y **vista mapa** (canvas con drill-down).
- **Modo zen**: reloj + búsqueda sin distracciones.
- **Tema claro/oscuro**, fondo personalizable.
- **Sync con tu repo privado de GitHub** (opcional).
- Click en el ícono de la extensión = guardar la pestaña actual.

---

## Estructura del sidebar

```
▼ ● MY COLLECTIONS   2 · 2  (+)    ← Grupo: círculo + botón + para crear colecciones
    ▶ 📁 A-FRAME                    ← Colección: ícono 📁, desplegable si tiene carpetas
         🗂 Canchas                   ← Carpeta: ícono 🗂, hoja final
      📁 FRAUDES                     ← Sin chevron si no tiene carpetas
▼ ● HOME4           14 · 65  (+)
    📁 CASAS CONTENEDOR
▼ ● PROYECTO NUEVO   0 · 0  (+)
```

| Nivel | Chevron | Ícono | Botón + | Color |
|---|---|---|---|---|
| Grupo | Sí | ● círculo | **Sí** (crea colecciones) | Sí |
| Colección | Si tiene carpetas | 📁 | No | No |
| Carpeta | No | 🗂 | No | No |

---

## Crear grupos, colecciones y carpetas

**`+ Nueva`** (arriba a la izquierda) abre el menú:

| Opción | Qué hace |
|---|---|
| **Nuevo Grupo** | Crea un espacio nuevo con su propio color |
| **Nueva Carpeta** | Crea una subcarpeta dentro de la colección seleccionada |

**El botón `+` junto al nombre de cada Grupo** crea una colección dentro de ese grupo. El prompt te dice en cuál lo estás haciendo.

Para crear una **carpeta**: selecciona la colección en el sidebar, luego entra a la tarjeta del tablero y usa el ícono 🗂 en la esquina superior derecha.

**Borrar:** cada carpeta tiene una ✕ a la derecha de su nombre en el tablero. Al entrar a una carpeta, el 🗑 de arriba borra la carpeta, no la colección. El botón **←** te regresa a la colección.

**Arrastrar para organizar:**

- Arrastra un bookmark a una carpeta → se mueve a la carpeta
- Arrastra un bookmark a otra colección → cambia de colección
- Arrastra una pestaña abierta del panel derecho a una carpeta o colección → se guarda ahí

---

## Instalar (Chrome / Edge / Brave / Opera)

1. Abre `chrome://extensions` en tu navegador
2. Activa **Modo de desarrollador** (toggle arriba a la derecha)
3. Click en **Cargar descomprimida**
4. Selecciona la carpeta `TabVault`
5. Listo. Abre una pestaña nueva y aparece TabVault.

Para fijar el ícono en la barra: click derecho en la barra de pestañas → **Fijar**.

---

## Importar tus bookmarks de Toby

1. En Toby: **Account Settings → Export → JSON**
2. En TabVault: click en **Importar** y selecciona ese `.json`
3. Verás el toast `Importados 182 colecciones · 1270 bookmarks`

Los grupos de Toby se convierten en **espacios** (sección izquierda del sidebar).

---

## Operadores de búsqueda

| Operador | Qué hace | Ejemplo |
|---|---|---|
| `texto` | Busca en la colección seleccionada | `SIP` |
| `%texto` | Busca en **todas** las colecciones | `%membrana` |
| `#texto` | Busca solo por **nombre de colección** | `#panel` |
| `@tag` | Busca por etiqueta | `@construcción` |
| `a\|b` | OR: encuentra cualquiera de los dos | `termo\|solar` |
| `?texto` | Abre Google con esa búsqueda | `?presupuesto SIP` |
| `!texto` | Abre ChatGPT con esa pregunta | `!qué es SIP` |

Atajo: `Ctrl+K` para saltar al buscador. `Esc` limpia.

---

## Vista mapa (canvas)

- Click en un **espacio** → ves sus colecciones alrededor
- Click en una **colección** → la seleccionas y vuelves al tablero
- Click en "volver a todos los espacios" → regresas al nivel 1
- Arrastra el fondo para moverte, rueda para zoom, botones `+` `−` `⤢`

---

## Sincronizar con GitHub (opcional)

1. Crea un repo **privado** en GitHub
2. Genera un Personal Access Token: GitHub → Settings → Developer settings → Personal access tokens → **scope `repo`**
3. En TabVault: ⚙ → pega usuario, repo, token, rama
4. **Subir a GitHub** = sube tu estado. **Bajar de GitHub** = lo restaura.

El archivo en GitHub es un solo `tabvault.json` en tu repo. Nadie más lo ve.

---

## Estructura del proyecto

```
TabVault/
├── manifest.json     Permisos y configuración de la extensión
├── newtab.html       Estructura de la interfaz
├── styles.css        Estilos + temas claro/oscuro
├── app.js            Toda la lógica
└── background.js     Guardar la pestaña actual con un click
```

**Cómo funcionan los datos:**

- Todo vive en un objeto `state` en memoria.
- Cada cambio llama a `save()`, que escribe en `chrome.storage.local`.
- `render()` vuelve a pintar la vista desde el estado.
- El import de Toby mapea `groups → espacios`, `lists → colecciones`, `cards → bookmarks`.

**Modelo de datos:**

```js
state.spaces      = [{ id, name, color }]
state.collections = [{ id, spaceId, name, bookmarks: [ids], folders: [...] }]
state.bookmarks   = { id, title, url, icon, note, tags: [] }
```

Un bookmark vive exactamente en un lugar: o en `collection.bookmarks` (suelto) o en `collection.folders[].bookmarks` (dentro de una carpeta). `detachBookmark()` lo saca de donde esté antes de moverlo, para que nunca quede duplicado.

---

## Lo que NO hace (y está bien que no haga)

- No tiene IA. Es 100% local y determinista.
- No sube tus datos a ningún servidor nuestro. No existe servidor.
- No cobra, no pide cuenta, no puede tirar tus datos.

Si algún día quieres cambiar algo, todo el código está en `app.js` y es JavaScript plano. No hay build, ni dependencias, ni `npm install`.