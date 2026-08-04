'use strict';

const { ORGANIZATION_NAME } = require('./config');

const BASE_URL = 'https://api.copiloto.ai/telematics';

/**
 * Trae eventos de telemetría de UN vehículo en un rango de fechas.
 *
 * Autenticación confirmada (Postman): header "auth" con el valor de la API key
 * de la empresa (no "Authorization: Bearer").
 *
 * Pendiente de confirmar con la API real: cómo pagina rangos de varios días.
 * Por ahora se asume una sola respuesta y se advierte por consola si
 * meta.total_items === meta.item_per_page, que es la señal de que puede haber
 * más datos de los que se están devolviendo (visto con datos reales: pedir 7
 * días trajo justo 1558 items = el tope de una sola página, correspondientes
 * a un solo día).
 */
async function fetchEventos({ apiKey, licensePlate, from, to }) {
  const url = new URL(`${BASE_URL}/${ORGANIZATION_NAME}/events`);
  url.searchParams.set('license_plate', licensePlate);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);

  const res = await fetch(url, {
    headers: { auth: apiKey },
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Copiloto API respondió ${res.status} para ${licensePlate}: ${texto}`);
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
        `total_items === item_per_page (${meta.item_per_page}). Si el rango es de ` +
        'varios días, puede faltar paginación (pendiente de confirmar con la API).'
    );
  }

  return eventos;
}

module.exports = { fetchEventos };
