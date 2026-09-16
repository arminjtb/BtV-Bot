# Integración con AniList

Todo lo nuevo es aditivo: **no se modifica ningún archivo existente**.

```
lib/anilist.js                  cliente de la API de AniList (GraphQL + OAuth)  [CJS]
lib/anilistStore.js             persistencia y reglas de negocio                [CJS]
lib/anilistUi.js                embeds y botones compartidos                    [ESM]
lib/anilistActions.js           escribir en la lista del usuario                [ESM]
commands/slash/anilist.js       /anilist (vincular, autorizar, config…)         [ESM]
commands/slash/calendario.js    /calendario                                     [ESM]
events/anilistNotifier.js       loop de avisos + sync de listas                 [ESM]
events/anilistInteractions.js   router de botones/menús "anilist_*"             [ESM]
events/anilistAuthDm.js         recibe el PIN de OAuth por DM                   [ESM]
```

`events/interactionCreate.js` y `events/messageCreate.js` **no se tocan**: los dos archivos nuevos
registran sus propios listeners y salen sin hacer nada si el evento no es suyo, igual que ya hacen
los tres archivos que escuchan `clientReady`.

---

## 1. Registrar la app en AniList

1. AniList → **Settings → Developer → Create New Client**
2. **Name**: lo que quieras (sale en la pantalla de autorización)
3. **Redirect URL**: exactamente `https://anilist.co/api/v2/oauth/pin`
4. Copia el **Client ID** y el **Client Secret**

## 2. Variables de entorno

```env
ANILIST_CLIENT_ID=12345
ANILIST_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Sin ellas todo lo de **lectura** sigue funcionando (avisos, menciones, `/calendario`); lo único que
se cae es `/anilist autorizar` y por tanto los botones de escritura.

## 3. Desplegar los comandos

Vuelve a correr tu script de registro de slash commands para que aparezcan `/anilist` y
`/calendario`.

## 4. Configurar el servidor

```
/anilist canal canal:#estrenos [rol_estrenos:@Anime]
```

Y cada miembro:

```
/anilist vincular usuario:TuNombreEnAniList     → avisos y menciones (sólo lectura)
/anilist autorizar                              → además, botones de añadir a planning
```

`autorizar` también vincula, así que quien quiera todo de una puede saltarse `vincular`.

---

## Qué hace cada requisito

| Pedido | Implementación |
|---|---|
| 1. Conectar con tu nombre de AniList | `/anilist vincular usuario:<nombre>`. Valida contra AniList y baja tu lista al momento. |
| 2. Avisos de planning en un canal | `/anilist canal`. El notificador revisa cada 5 min qué se emitió y menciona **a todos** los que lo tengan en planning o viendo, en un solo mensaje. |
| 3. Comando de calendario | `/calendario` — semana lunes→domingo, menú para cambiar de día, y filtro *Del club / Los míos / Todos*. |
| 4. Avisar aunque nadie lo tenga | Los **estrenos** (episodio 1) se anuncian siempre, con descripción, portada, banner, estudio, géneros y dónde verlo. |
| 5. Botón para añadir a planning | Cada aviso lleva **➕ Añadir a planning**, **▶️ Estoy viéndolo** y **✅ Visto ep. N**. El `/calendario` además trae un menú para añadir cualquiera de los del día. |

### La decisión que tomé por ti (y cómo cambiarla)

"Avisar aunque nadie lo tenga en planning" aplicado a **todos los episodios** serían ~300 mensajes
por semana y el canal quedaría inservible. Así que:

- **Estreno (ep. 1)** → se anuncia siempre, lo siga alguien o no.
- **Episodios 2 en adelante** → sólo si alguien del servidor lo tiene en lista (y a esa persona se
  la menciona).

Se ajusta sin tocar código:

```
/anilist config estrenos:Todos|Sólo los que alguien siga|Ninguno
/anilist config episodios:true|false
/anilist config popularidad_minima:1500
/anilist config paises:JP
/anilist config zona_horaria:America/Mexico_City
```

`popularidad_minima` y `paises` **sólo filtran estrenos que nadie del club sigue** — si alguien lo
tiene en planning, se anuncia pase lo que pase. Por defecto: sólo Japón, popularidad ≥ 1500, sin
hentai. Bájale la popularidad a 0 si quieres absolutamente todo.

---

## Detalles de implementación

**Rate limit.** AniList permite 90 req/min. `lib/anilist.js` mete todas las requests en una cola
secuencial con 750 ms de separación y respeta el `Retry-After` en caso de 429, así que el
notificador y los comandos no se pueden pisar entre ellos.

**Antiduplicados.** Antes de mandar un aviso se inserta un doc `anilist:ann:<guild>:<media>:<ep>`.
El `insertOne` es atómico, así que si dos ticks se solapan sólo uno gana. Se limpian a los 30 días.

**Caídas del bot.** El cursor `lastAiringCheck` sólo avanza si la query a AniList salió bien, así
que un fallo de red se reintenta solo. Si el bot estuvo caído más de 6 horas se recorta la ventana
para no vomitar cientos de avisos atrasados de golpe.

**Listas privadas.** Con `/anilist vincular` a secas sólo se lee lo público; si tu lista es privada
te lo dice y te manda a `/anilist autorizar`, que sí lee con tu token.

**Cache de listas.** Se refrescan cada 30 min (`/anilist sincronizar` fuerza). Cuando alguien usa
un botón de añadir, la cache se parchea al instante para que el siguiente episodio ya le llegue.

**Zona horaria.** `/calendario` usa la del servidor (`America/Mexico_City` por defecto). El cálculo
de la semana saca el offset real con `Intl`, mismo truco que `lib/readathon.js`, así que no depende
de en qué zona corra el proceso.

**Navegación del calendario.** Los menús de día/filtro sólo los usa quien lanzó el comando (si no,
"Los míos" no significaría nada al ser un mensaje compartido). El menú de **añadir a planning** sí
lo puede usar cualquiera: actúa sobre la lista de quien pulsa.

## Colección compartida (`client.db`)

Mismo patrón que `readathon`/`coImmersion`/`torboxJob`, discriminando por `kind`:

| `kind` | `_id` | Contenido |
|---|---|---|
| `anilistUser` | `anilist:user:<discordId>` | vínculo, token, cache de planning/current |
| `anilistGuild` | `anilist:guild:<guildId>` | canal y config de avisos |
| `anilistAnn` | `anilist:ann:<guild>:<media>:<ep>` | antiduplicados |
| `anilistState` | `anilist:state` | cursor del notificador |

## Notas

- El comando se llama `/calendario` (el resto del bot está en español). Si lo prefieres `/calendar`,
  cambia el `.setName("calendario")` en `commands/slash/calendario.js` y las tres cadenas
  `"calendario"` de `events/anilistInteractions.js` y `handleComponent`.
- `guild.members.fetch(id)` individual va por REST y no necesita el intent privilegiado de
  *Server Members*. Los DMs sí necesitan `DirectMessages` + `Partials.Channel`, que ya los tienes
  por el `/link` actual.
- No pude probar contra la API real desde mi entorno (sin salida a `graphql.anilist.co`). La lógica
  pura — fechas, filtros, parseo — sí está probada. Las queries GraphQL están escritas contra el
  esquema v2 actual; si algo falla será ahí y lo verás en consola con el mensaje que devuelva
  AniList.
