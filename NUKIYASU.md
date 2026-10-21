# Integración Nukiyasu

La integración está desactivada por defecto. BtV-Bot consulta Nukiyasu mediante su API autenticada y no modifica el proyecto Nukiyasu.

## Cuenta de servicio

Crear una cuenta dedicada en Nukiyasu para BtV-Bot. No es necesario utilizar una cuenta administradora. La opción de contenido maduro debe decidirse expresamente: `NUKIYASU_ALLOW_MATURE=false` es el valor recomendado.

La URL debe ser la raíz accesible desde el contenedor de BtV-Bot, sin `/api`:

```text
NUKIYASU_URL=http://nukiyasu:8080
```

## Variables de entorno

```text
NUKIYASU_ENABLED=false
NUKIYASU_URL=
NUKIYASU_USERNAME=
NUKIYASU_PASSWORD=
NUKIYASU_ALLOW_MATURE=false
NUKIYASU_SOCKET_ENABLED=true
NUKIYASU_POLL_INTERVAL_MS=900000
NUKIYASU_STABILIZATION_MS=600000
NUKIYASU_MAX_STABILIZATION_MS=3600000
NUKIYASU_MAX_NOTIFICATIONS_PER_RUN=10
NUKIYASU_TIMEOUT_MS=15000
NUKIYASU_MAX_PAGES=1000
```

Los tokens JWT sólo viven en memoria del proceso. No se escriben en MongoDB ni en logs.

## Comandos

```text
/nukiyasu catalogo [categoria] [pagina]
/nukiyasu buscar texto [categoria]
/nukiyasu obra titulo
/nukiyasu novedades [limite]
/nukiyasu configurar [canal] [activo]
```

`configurar` requiere `Gestionar servidor`. Las consultas son independientes de la configuración del canal de avisos.

## Detección y avisos

La primera sincronización crea una línea base y no publica mensajes. Las siguientes sincronizaciones comparan los `_id` estables de series y volúmenes.

`LIBRARY_UPDATE` de Socket.IO inicia una reconciliación rápida. Un polling periódico recupera cambios si el socket estaba desconectado. Los snapshots se versionan y sólo se activa una versión nueva cuando el catálogo completo se ha descargado correctamente.

Las series nuevas se mantienen en una ventana de estabilización configurable. Si aparecen más volúmenes durante esa ventana, se agrupan en un único aviso. Los volúmenes posteriores de una serie ya conocida se anuncian de forma independiente o agrupada si llegan durante la misma ventana.

Las portadas se descargan con JWT y se adjuntan al mensaje de Discord. No se publican URLs privadas de `/api/static`.

## Prueba aislada en OMV

El `docker-compose.yml` existente sólo referencia la imagen publicada `elaxdev/btvbot:latest`; no contiene una sección `build`. Por eso `docker compose build btvbot` no construye esta rama. La prueba utiliza [docker-compose.test.yml](C:\Users\arash\Documents\BtV-Bot\docker-compose.test.yml), que construye el código local y usa otro contenedor MongoDB y otro volumen.

### 1. Copiar el código desde Windows

En Windows, copia la carpeta del repositorio a OMV mediante WinSCP, SMB o `scp`. Usa una carpeta separada, por ejemplo:

```text
/srv/btv-bot-nukiyasu-test
```

No copies `.env`, credenciales, `node_modules` ni salidas generadas. Incluye `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.test.yml`, `.env.test.template` y el código fuente.

### 2. Crear las variables de pruebas

En OMV:

```text
cd /srv/btv-bot-nukiyasu-test
cp .env.test.template .env.test
```

Edita `.env.test` y completa:

- `BOT_TOKEN`: token del bot Discord de pruebas.
- `CLIENT_ID`: application ID de ese bot.
- `DISCORD_GUILD_ID`: ID del servidor Discord de pruebas.
- `NUKIYASU_URL`: URL accesible desde el contenedor.
- `NUKIYASU_USERNAME` y `NUKIYASU_PASSWORD`: cuenta dedicada.

No uses el token de Umaru, el `CLIENT_ID` de Umaru ni la colección de producción. El fichero `.env.test` está ignorado por Git.

### 3. Construir y arrancar

```text
docker compose -f docker-compose.test.yml --env-file .env.test build
docker compose -f docker-compose.test.yml --env-file .env.test up -d
```

El compose de prueba crea:

- `btvbot-nukiyasu-test`: bot independiente.
- `btvbot-nukiyasu-test-mongo`: MongoDB independiente.
- Base `nihongotracker_test` y colección `btv_test`.
- Volumen `btvbot_nukiyasu_test_mongo_data`.

Si Nukiyasu está en otro compose, no uses `localhost` desde BtV-Bot. Usa la IP/hostname de OMV o una red Docker compartida. El bot sólo realiza peticiones autenticadas de lectura.

### 4. Revisar logs

```text
docker compose -f docker-compose.test.yml --env-file .env.test logs -f btvbot-nukiyasu-test
```

Debe aparecer, en este orden aproximado:

1. Carga del comando `nukiyasu`.
2. Carga de `nukiyasuNotifier`.
3. Registro de comandos en el guild de pruebas.
4. Conexión a MongoDB.
5. Creación de la línea base de Nukiyasu.

La primera línea base no debe publicar ningún anuncio.

### 5. Probar Discord

En el servidor de pruebas:

```text
/nukiyasu configurar canal:#canal-pruebas activo:true
/nukiyasu configurar
/nukiyasu catalogo categoria:manga
/nukiyasu buscar texto:<título>
/nukiyasu obra titulo:<selecciona-una-sugerencia>
/nukiyasu novedades
```

`DISCORD_GUILD_ID` hace que los comandos se registren sólo en ese guild y evita esperar al registro global.

### 6. Probar un volumen nuevo sin tocar producción

No existe una forma segura de simular una incorporación real modificando el catálogo de la instancia Nukiyasu de producción. Para esta prueba utiliza una instancia Nukiyasu de staging o una copia de prueba con una cuenta dedicada.

En staging:

1. Arranca BtV-Bot y espera a que cree la línea base.
2. Añade o importa un volumen en la biblioteca de staging.
3. Espera el evento `LIBRARY_UPDATE` o el siguiente polling.
4. Comprueba que aparece una única novedad después de la ventana de estabilización.
5. Reinicia sólo `btvbot-nukiyasu-test` y verifica que no duplica el anuncio.

Contra producción sólo deben probarse consultas, búsqueda, portadas y la creación inicial de la línea base; no debe provocarse ninguna importación.

### 7. Detener y eliminar sólo la prueba

```text
docker compose -f docker-compose.test.yml --env-file .env.test down
```

Para borrar también los datos MongoDB exclusivos de esta prueba:

```text
docker compose -f docker-compose.test.yml --env-file .env.test down -v
```

No ejecutes `down -v` sobre el compose de Umaru. Los nombres y el volumen del compose de prueba son distintos.

No se debe ejecutar ningún comando de despliegue contra el servidor de Nukiyasu desde este proyecto.

### Reconstruir una línea base incompleta

Si una ejecución antigua registró exactamente 100 volúmenes, detén sólo el bot de pruebas, cambia temporalmente `NUKIYASU_REBUILD_BASELINE_ONCE=true` en `.env.test` y vuelve a construir y arrancar el compose de pruebas. La siguiente sincronización descargará todas las páginas, reemplazará el snapshot y no creará anuncios históricos. El proceso consume la bandera después de una reconstrucción correcta; si la consulta falla, se conserva para reintentar.

Comprueba en los logs una línea como `Línea base reconstruida (... volúmenes)` y vuelve a dejar la variable en `false` antes de futuras ejecuciones.

## Pruebas

```text
npm test
# Equivalente directo si npm no está disponible:
node --test --test-isolation=none tests/nukiyasu.test.js
```

Las pruebas utilizan un catálogo Nukiyasu simulado, una base de datos en memoria, un transporte HTTP simulado y un WebSocket simulado. Cubren la línea base, detección por `_id`, una importación de 20 volúmenes, importaciones progresivas, filtros maduros, paginación, búsqueda japonesa, renovación JWT, portadas, Socket.IO y conservación del snapshot activo ante fallos.

## Limitaciones conocidas

- Nukiyasu no proporciona un cursor incremental ni un registro durable de eventos.
- Socket.IO sólo sirve como disparador; el polling sigue siendo necesario.
- Si Discord acepta un mensaje pero la conexión falla antes de registrar la entrega, existe un riesgo residual de duplicado.
- La cuenta de servicio determina qué contenido puede consultar BtV-Bot.
- `releaseDate` y `lastModifiedDate` no se utilizan como fecha de incorporación.
