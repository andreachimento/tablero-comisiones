# Tablero de Comisiones - Coderhouse (Vercel)

Este proyecto tiene 3 archivos importantes:

- `index.html` - la pagina del tablero (lo que ve la gente).
- `api/dashboard-data.js` - funcion que corre en el servidor de Vercel, trae
  los datos de la API de Coderhouse usando las claves guardadas de forma
  segura (nunca viajan al navegador de quien usa el tablero).
- `vercel.json` - le dice a Vercel que le de mas tiempo a esa funcion (los
  planes gratis limitan el tiempo de ejecucion por defecto).

## Como publicarlo (todo con clicks, sin usar la terminal)

1. Crear una cuenta en https://github.com (gratis) si no tenes una.
2. Crear un repositorio nuevo (botón "New repository"), publico o privado,
   con cualquier nombre (ej: `tablero-comisiones`).
3. Subir estos 4 archivos (y la carpeta `api` con su archivo adentro) usando
   "Add file > Upload files" en la pagina del repositorio - se pueden
   arrastrar directamente con el mouse.
4. Crear una cuenta en https://vercel.com eligiendo "Continue with GitHub"
   (asi quedan conectadas las dos cuentas).
5. En Vercel: "Add New..." > "Project" > elegir el repositorio que subiste
   > "Import".
6. Antes de darle a "Deploy", abrir la seccion "Environment Variables" y
   cargar estas 3 (los mismos valores que tenes en tu archivo `.env`, SIN
   comillas):
     - `BACKOFFICE_API_URL`
     - `CLAUDE_STUDENT_API_KEY`
     - `CLAUDE_FINANCE_API_KEY`
7. Hacer clic en "Deploy". Cuando termine (1-2 minutos), Vercel te da un
   link publico (algo asi como `tablero-comisiones.vercel.app`).

Ese link es el que se comparte con el equipo. Cada vez que alguien lo abre,
o aprieta "Actualizar datos", se traen los datos mas recientes del sistema.

## Si en el futuro se actualiza el diseño o se agregan filtros

Hay que reemplazar `index.html` (o `api/dashboard-data.js` si el cambio es
de datos) directamente en GitHub (clic en el archivo > icono de lapiz >
pegar el contenido nuevo > "Commit changes"). Vercel vuelve a publicar solo
automaticamente cuando detecta el cambio - no hace falta tocar nada en
Vercel.
