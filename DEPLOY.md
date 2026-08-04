# Cómo publicar el backend en una URL real (sin VSCode)

No necesitas VSCode ni instalar nada en tu computador. Todo esto se hace desde el navegador, en dos páginas web: GitHub (donde vive el código) y Render (donde el código corre y te da la URL).

## Paso 1: Subir el código a GitHub

1. Entra a [github.com](https://github.com) y crea una cuenta gratis si no tienes una.
2. Arriba a la derecha, haz clic en el botón **+** → **New repository**.
3. Ponle un nombre, por ejemplo `rendimiento-buses-backend`. Puede ser **Private** (privado), no hace falta que sea público.
4. Haz clic en **Create repository**.
5. En la página del repositorio recién creado, busca el link **"uploading an existing file"** (o el botón **Add file → Upload files**).
6. Arrastra ahí todos estos archivos (menos `.env` si llegaras a crear uno — ese nunca se sube):
   - `app.js`
   - `server.js`
   - `rendimientoHandler.js`
   - `copilotoClient.js`
   - `config.js`
   - `rendimiento.js`
   - `package.json`
   - `.gitignore`
7. Haz clic en **Commit changes** (el botón verde).

Con eso tu código ya está "en la nube", listo para que Render lo lea.

## Paso 2: Crear el servicio en Render

1. Entra a [render.com](https://render.com) y crea una cuenta gratis (puedes usar el botón "Sign up with GitHub" para conectar todo de una vez).
2. Haz clic en **New +** → **Web Service**.
3. Selecciona el repositorio que acabas de crear (`rendimiento-buses-backend`).
4. En la configuración:
   - **Name**: el nombre que quieras, ej. `rendimiento-buses`.
   - **Region**: la más cercana (Oregon u otra en Sudamérica si está disponible).
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free.
5. Antes de darle a **Create Web Service**, baja a la sección **Environment Variables** y agrega:
   - `COPILOTO_ORG_NAME` = el organization_name real que usas en la URL de la API.
   - `COPILOTO_EMPRESA_API_KEYS` = el JSON con las API keys por empresa, en una sola línea. Ejemplo:
     `{"empresa_demo":"MjA0MA==_.la_api_key_real_aqui"}`
6. Haz clic en **Create Web Service**.

Render va a instalar todo y arrancar el servidor. En unos minutos te va a dar una URL como:

```
https://rendimiento-buses.onrender.com
```

Esa URL ya es real y pública — puedes abrirla en Chrome desde cualquier computador o celular.

## Paso 3: Probarlo

Para ver el rendimiento de un vehículo, abre en el navegador (reemplazando los datos reales):

```
https://rendimiento-buses.onrender.com/api/rendimiento?empresa=empresa_demo&placas=VSKP44&desde=2026-07-01T00:00:00Z&hasta=2026-07-01T23:59:00Z
```

Vas a ver el resultado en formato JSON (texto con llaves `{ }`) — es normal, todavía no hay una pantalla bonita, eso viene con el frontend (el siguiente paso del proyecto). Pero ya es la prueba de que el sistema completo — API de Copiloto → backend → resultado — funciona en una URL real.

**Nota sobre el plan gratis de Render:** el servicio "se duerme" tras 15 minutos sin uso y tarda unos segundos en despertar la próxima vez que alguien lo visita. Para uso interno de pruebas está bien; si más adelante esto va a producción con la empresa usándolo todos los días, conviene pasar a un plan pago (bajo costo) para que no se duerma.

## Paso 4 (más adelante): conectar connectflotas.com

Cuando tengas acceso al panel donde se administra el DNS del dominio (normalmente en el sitio donde se compró, como GoDaddy, Namecheap, etc.):

1. En Render, dentro de tu servicio, ve a **Settings → Custom Domains → Add Custom Domain**.
2. Escribe algo como `api.connectflotas.com` (un subdominio, para no tocar el dominio principal).
3. Render te va a dar un registro DNS (tipo CNAME) para agregar en el panel del dominio.
4. Una vez agregado ahí, en unos minutos/horas `api.connectflotas.com` va a apuntar directo a tu backend.

Si no sabes dónde se administra el DNS de connectflotas.com, revisa el correo de confirmación de cuando se compró el dominio, o pregunta a quien lo gestionó — normalmente dice el registrador (GoDaddy, Namecheap, Cloudflare, etc.).
