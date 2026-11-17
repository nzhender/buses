'use strict';

const { ORGANIZATION_NAME } = require('./config');

const BASE_URL = 'https://api.copiloto.ai/telematics';

// Cada tramo se pide por separado: una consulta de varios días a la vez para
// un vehículo con mucha telemetría (ej. SWHG77) hacía que Copiloto tardara más
// de 5 minutos en responder (HeadersTimeoutError) o devolviera solo una
// "página" parcial. Tramos de 24 h son livianos y evitan ambos problemas.
const TRAMO_MS = 24 * 60 * 60 * 1000;

// Timeout por intento y reintentos: si Copiloto se cuelga, se corta en
// segundos (no en 5 minutos) y se reintenta antes de rendirse.
const TIMEOUT_MS = 60 * 1000;
const REINTENTOS = 2;
const ESPERA_REINTENTO_MS = 1500;

// Cuántos tramos se piden en paralelo por vehículo (bajo, para no saturar a
// Copiloto cuando además se consultan varias patentes a la vez).
const CONCURRENCIA_TRAMOS = 2;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Divide [from, to] en ventanas consecutivas de a lo más TRAMO_MS. */
function dividirEnTramos(from, to) {
  const inicio = new Date(from).getTime();
  const fin = new Date(to).getTime();
  const tramos = [];
  for (let t = inicio; t < fin; t += TRAMO_MS) {
    tramos.push({
      from: new Date(t).toISOString(),
      to: new Date(Math.min(t + TRAMO_MS, fin)).toISOString(),
    });
  }
  return tramos;
}

/** Pide UN tramo con timeout y reintentos. Lanza error solo si se agotan los intentos. */
async function fetchTramo({ apiKey, licensePlate, from, to }) {
  const url = new URL(`${BASE_URL}/${ORGANIZATION_NAME}/events`);
  url.searchParams.set('license_plate', licensePlate);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);

  let ultimoError;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    try {
      const res = await fetch(url, {
        headers: { auth: apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        const err = new Error(`Copiloto API respondió ${res.status} para ${licensePlate}: ${texto}`);
        // Errores 4xx (salvo 429) no se arreglan reintentando.
        err.noReintentar = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }

      const body = await res.json();
      const eventos = body?.data?.[licensePlate] || [];
      const meta = body?.meta || {};

      if (
        meta.total_items &&
        meta.item_per_page &&
        meta.total_items === meta.item_per_page &&
        eventos.length >= meta.item_per_page
      ) {
        console.warn(
          `[copiloto] Posible corte de datos para ${licensePlate} (${from} a ${to}): ` +
            `total_items === item_per_page (${meta.item_per_page}).`
        );
      }

      return eventos;
    } catch (err) {
      ultimoError = err;
      if (err.noReintentar || intento === REINTENTOS) break;
      console.warn(
        `[copiloto] Intento ${intento + 1} falló para ${licensePlate} (${from} a ${to}): ` +
          `${err.cause?.code || err.name}: ${err.message}. Reintentando...`
      );
      await esperar(ESPERA_REINTENTO_MS * (intento + 1));
    }
  }

  const causa = ultimoError.cause?.code || ultimoError.name;
  throw new Error(`No se pudieron obtener eventos de ${licensePlate} (${from} a ${to}): ${causa}: ${ultimoError.message}`);
}

/**
 * Trae eventos de telemetría de UN vehículo en un rango de fechas, pidiendo
 * el rango en tramos de 24 h y uniendo los resultados (sin duplicados en los
 * bordes de cada tramo).
 *
 * Autenticación confirmada (Postman): header "auth" con el valor de la API key
 * de la empresa (no "Authorization: Bearer").
 */
async function fetchEventos({ apiKey, licensePlate, from, to }) {
  const tramos = dividirEnTramos(from, to);
  const resultados = new Array(tramos.length);
  let siguiente = 0;

  async function trabajador() {
    while (siguiente < tramos.length) {
      const i = siguiente++;
      resultados[i] = await fetchTramo({ apiKey, licensePlate, ...tramos[i] });
    }
  }

  const trabajadores = Array.from({ length: Math.min(CONCURRENCIA_TRAMOS, tramos.length) }, trabajador);
  await Promise.all(trabajadores);

  const vistos = new Set();
  const eventos = [];
  for (const lista of resultados) {
    for (const e of lista) {
      const clave = `${e.gps_utc_time}|${e.odometer}|${e.odoliter}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      eventos.push(e);
    }
  }

  console.log(`[copiloto] ${licensePlate}: ${eventos.length} eventos en ${tramos.length} tramo(s).`);
  return eventos;
}

/**
 * Trae el nombre de la empresa y la lista de vehículos asociados a la API key.
 * Mismo esquema de auth que fetchEventos: header "auth" con la API key de la
 * empresa. La empresa se identifica por CUÁL api key se usa, no por el path
 * (organization en el path sigue siendo el organization_name fijo).
 *
 * Respuesta real observada:
 * {
 *   data: {
 *     company: { name },
 *     vehicle_groups: [{ id, name }],
 *     vehicles: [{ license_plate, imei, vin }]
 *   }
 * }
 */
async function fetchOrganization({ apiKey }) {
  const url = new URL(`${BASE_URL}/${ORGANIZATION_NAME}/organization`);

  const res = await fetch(url, {
    headers: { auth: apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Copiloto API (organization) respondió ${res.status}: ${texto}`);
  }

  const body = await res.json();
  const data = body?.data || {};

  return {
    nombre: data.company?.name || null,
    vehiculos: (data.vehicles || []).map((v) => ({
      placa: v.license_plate,
      imei: v.imei,
      vin: v.vin,
    })),
  };
}

module.exports = { fetchEventos, fetchOrganization };
