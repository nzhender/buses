'use strict';

/**
 * Geocodificación inversa (coordenadas -> nombre de localidad) usando
 * OpenStreetMap Nominatim. Es gratuito y no requiere API key, pero su
 * política de uso limita a ~1 consulta por segundo y exige un User-Agent
 * identificable — ambas cosas se respetan aquí.
 *
 * Si más adelante se necesita mayor velocidad o cobertura, este es el único
 * archivo a reemplazar (por ejemplo por Google Geocoding o Mapbox); el resto
 * de la app solo depende de resolverLocalidades().
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

// Identifica la app ante Nominatim, como exige su política de uso.
// Cambiar el dominio de contacto por uno real de la empresa si se dispone de uno.
const USER_AGENT = 'ConnectBuses-RendimientoApp/1.0';

// Cache en memoria del proceso: mismas coordenadas (redondeadas) no se
// vuelven a consultar mientras el servidor siga corriendo.
const cache = new Map();

// Tope de consultas NUEVAS por request, para no volver una respuesta
// eterna si el rango trae muchos viajes con ubicaciones distintas. Las que
// queden fuera del tope simplemente no tendrán localidad resuelta.
const MAX_CONSULTAS_POR_REQUEST = 40;

// Nominatim exige como máximo ~1 solicitud por segundo.
const ESPERA_ENTRE_CONSULTAS_MS = 1100;

/** Redondear a 4 decimales (~11 metros) agrupa puntos del mismo lugar (ej. mismo terminal/depósito). */
function claveCoordenada(lat, lon) {
  return lat.toFixed(4) + ',' + lon.toFixed(4);
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reverseGeocodeUna(lat, lon) {
  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'es',
    },
  });

  if (!res.ok) {
    throw new Error(`Nominatim respondió ${res.status}`);
  }

  const body = await res.json();
  const addr = body.address || {};

  // Nominatim no siempre usa el mismo campo según el país/zona; se prueban
  // en orden de especificidad decreciente.
  return (
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.county ||
    addr.state_district ||
    null
  );
}

/**
 * Resuelve la localidad de una lista de coordenadas, deduplicando por
 * coordenada redondeada y respetando el límite de velocidad de Nominatim.
 * Nunca lanza: si una consulta falla (red caída, timeout, etc.), esa
 * coordenada queda con localidad `null` en vez de romper el resto.
 *
 * @param {Array<{lat: number, lon: number}>} coordenadas
 * @returns {Promise<Map<string, string|null>>} clave (ver claveCoordenada) -> localidad
 */
async function resolverLocalidades(coordenadas) {
  const resultado = new Map();
  const pendientes = [];
  const yaEncoladas = new Set();

  for (const c of coordenadas) {
    if (!c) continue;
    const clave = claveCoordenada(c.lat, c.lon);

    if (cache.has(clave)) {
      resultado.set(clave, cache.get(clave));
      continue;
    }

    if (yaEncoladas.has(clave)) continue;
    yaEncoladas.add(clave);
    pendientes.push({ clave, lat: c.lat, lon: c.lon });
  }

  const aConsultar = pendientes.slice(0, MAX_CONSULTAS_POR_REQUEST);

  for (let i = 0; i < aConsultar.length; i++) {
    const { clave, lat, lon } = aConsultar[i];
    try {
      const localidad = await reverseGeocodeUna(lat, lon);
      cache.set(clave, localidad);
      resultado.set(clave, localidad);
    } catch (err) {
      console.warn(`[geocoding] No se pudo resolver localidad para ${clave}: ${err.message}`);
      cache.set(clave, null);
      resultado.set(clave, null);
    }

    if (i < aConsultar.length - 1) {
      await esperar(ESPERA_ENTRE_CONSULTAS_MS);
    }
  }

  // Las que quedaron fuera del tope no se consultan; localidad null.
  for (let i = MAX_CONSULTAS_POR_REQUEST; i < pendientes.length; i++) {
    resultado.set(pendientes[i].clave, null);
  }

  return resultado;
}

module.exports = { resolverLocalidades, claveCoordenada };
