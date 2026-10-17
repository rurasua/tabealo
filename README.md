# Tablealo

Gestor de pestañas y enlaces. **Tus datos en tu máquina, sin servidor, sin cuenta, sin cobros.**

Inspirado en la idea de TheTab.Ninja y en las funcionalidades de Toby, pero con código propio y sin dependencias externas.

---

## Qué hace

- **Importa el export JSON de Toby** (soporta v4): tus 22 Departamentos, 182 Escritorios y 1,270 enlaces entran en un click.
- **Panel de pestañas abiertas**: arrastra cualquier pestaña abierta a un Escritorio y se guarda.
- **Capturar ventana completa**: convierte todo lo que tienes abierto en un Escritorio nuevo.
- **Reabrir Escritorio como grupo de pestañas** de Chrome.
- **Búsqueda con operadores** (ver abajo).
- **Vista tablero** (grid) y **vista mapa** (canvas con drill-down).
- **Modo zen**: reloj + búsqueda sin distracciones.
- **Tema claro/oscuro**, fondo personalizable.
- **Sync con tu repo privado de GitHub** (opcional).
- Click en el ícono de la extensión = guardar la pestaña actual.

---

## La jerarquía

Cuatro niveles, sin carpetas:

```
Oficina
└── Departamento      (círculo de color)
    └── Escritorio    (el nombre lo pones tú)
        └── Enlace
```

| Nivel | Chevron | Ícono | Botón `+` | Color |
|---|---|---|---|---|
| Oficina | Sí | 🏢 nombre en mayúsculas | **Sí** (crea Departamento) | No |
| Departamento | Sí | ● círculo | **Sí** (crea Escritorio) | Sí |
| Escritorio | No | 🖥️ | No | No |

Un enlace se guarda **directo** en su Escritorio. No hay carpetas intermedias: un solo nivel de agrupación debajo del Escritorio, que es justo lo que hace falta.

---

## Crear Offices, Departamentos y Escritorios

**`+ Nueva`** (arriba a la izquierda) abre el menú:

| Opción | Qué hace |
|---|---|
| **Nueva Oficina** | Crea una Oficina con su primer Departamento listo |
| **Nuevo Departamento** | Crea un Departamento con su círculo de color en la Oficina seleccionada |
| **Nuevo Escritorio** | Crea un Escritorio con el nombre que quieras en el Departamento seleccionado |

**El botón `+` junto al nombre de cada Oficina** crea un Departamento dentro de esa Oficina.
**El botón `+` junto al nombre de cada Departamento** crea un Escritorio dentro de ese Departamento.

El prompt siempre te dice en cuál lo estás haciendo, para que nunca crees algo donde no querías.

**Borrar:** los 🗑 del encabezado de cada Oficina y de cada Departamento los eliminan junto con todo lo que tienen dentro. Antes de hacerlo, la confirmación te dice exactamente cuántos departamentos, escritorios y enlaces se van a perder. El 🗑 de una tarjeta del tablero borra ese Escritorio con todos sus enlaces, y el ✕ en cada fila borra solo ese enlace.

Los botones 🗑 solo aparecen cuando pones el cursor encima del encabezado, para que no estorben al leer los nombres.

**Arrastrar para organizar:**

- Arrastra un enlace a otro Escritorio → cambia de Escritorio
- Arrastra una pestaña abierta del panel derecho a un Escritorio → se guarda ahí

---

## Instalar (Chrome / Edge / Brave / Opera)

1. Abre `chrome://extensions` en tu navegador
2. Activa **Modo de desarrollador** (toggle arriba a la derecha)
3. Click en **Cargar descomprimida**
4. Selecciona la carpeta `Tablealo`
5. Listo. Abre una pestaña nueva y aparece Tablealo.

Para fijar el ícono en la barra: click derecho en la barra de pestañas → **Fijar**.

---

## Importar tus enlaces de Toby

1. En Toby: **Account Settings → Export → JSON**
2. En Tablealo: click en **Importar** y selecciona ese `.json`
3. Verás el toast `Importados 22 departamentos · 182 escritorios · 1270 enlaces`

El importador mapea así:

| Toby | Tablealo |
|---|---|
| `groups` | Departamentos (dentro de una sola Oficina llamada "Importado de Toby") |
| `lists` | Escritorios |
| `cards` | Enlaces, directos en su Escritorio |

---

## Operadores de búsqueda

| Operador | Qué hace | Ejemplo |
|---|---|---|
| `texto` | Busca en el Escritorio seleccionado | `SIP` |
| `%texto` | Busca en **todos** los Escritorios | `%membrana` |
| `#texto` | Busca solo por **nombre de Escritorio** | `#panel` |
| `@tag` | Busca por etiqueta | `@construcción` |
| `a\|b` | OR: encuentra cualquiera de los dos | `termo\|solar` |
| `?texto` | Abre Google con esa búsqueda | `?presupuesto SIP` |
| `!texto` | Abre ChatGPT con esa pregunta | `!qué es SIP` |

Atajo: `Ctrl+K` para saltar al buscador. `Esc` limpia.

---

## Vista mapa (canvas)

- Click en una **Oficina** → ves sus Departamentos
- Click en un **Departamento** → ves sus Escritorios
- Click en un **Escritorio** → lo seleccionas y vuelves al tablero
- Usa "volver a los departamentos" / "volver a todas las oficinas" para subir de nivel
- Arrastra el fondo para moverte, rueda para zoom, botones `+` `−` `⤢`

---

## Sincronizar con GitHub (opcional)

1. Crea un repo **privado** en GitHub
2. Genera un Personal Access Token: GitHub → Settings → Developer settings → Personal access tokens → **scope `repo`**
3. En Tablealo: ⚙ → pega usuario, repo, token, rama
4. **Subir a GitHub** = sube tu estado. **Bajar de GitHub** = lo restaura.

El archivo en GitHub es un solo `tablealo.json` en tu repo. Nadie más lo ve.

El **exportar JSON** sigue existiendo siempre y es el respaldo que nunca depende de nadie.

---

## Estructura del proyecto

```
Tablealo/
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
- El import de Toby mapea `groups → Departamentos`, `lists → Escritorios`, `cards → enlaces`.

**Modelo de datos:**

```js
state.offices     = [{ id, name, color, shared }]
state.spaces      = [{ id, officeId, name, color }]      // Departamentos
state.collections = [{ id, spaceId, name, bookmarks: [ids] }]  // Escritorios
state.bookmarks   = { id, title, url, icon, note, tags: [] }
```

Los nombres internos `spaces` y `collections` son históricos: en la interfaz esos niveles se llaman **Departamento** y **Escritorio**. No hay carpetas en el modelo.

Un enlace vive exactamente en un Escritorio. `detachBookmark()` lo saca de donde esté antes de moverlo, para que nunca quede duplicado.

---

## Lo que NO hace (y está bien que no haga)

- No tiene IA. Es 100% local y determinista.
- No sube tus datos a ningún servidor nuestro. No existe servidor.
- No cobra, no pide cuenta, no puede tirar tus datos.

Si algún día quieres cambiar algo, todo el código está en `app.js` y es JavaScript plano. No hay build, ni dependencias, ni `npm install`.