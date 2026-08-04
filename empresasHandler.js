'use strict';

const config = require('./config');
const copilotoClient = require('./copilotoClient');

/**
 * Devuelve la lista de empresas configuradas (COPILOTO_EMPRESA_API_KEYS),
 * cada una con su nombre real y sus vehículos, consultando la API de
 * Copiloto (/organization) con la API key de cada empresa.
 *
 * Si una empresa falla (ej. API key inválida, Copiloto caído), no rompe la
 * lista completa: se incluye igual con un campo "error" para que el front
 * pueda mostrar el resto y avisar de esa empresa en particular.
 */
async function obtenerEmpresas() {
  const empresaIds = config.listEmpresaIds();

  const resultados = await Promise.all(
    empresaIds.map(async (empresaId) => {
      try {
        const apiKey = config.getApiKeyForEmpresa(empresaId);
        const { nombre, vehiculos } = await copilotoClient.fetchOrganization({ apiKey });
        return { empresaId, nombre: nombre || empresaId, vehiculos };
      } catch (err) {
        return { empresaId, nombre: empresaId, vehiculos: [], error: err.message };
      }
    })
  );

  return resultados;
}

module.exports = { obtenerEmpresas };
