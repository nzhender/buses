'use strict';

// dotenv es opcional: si no está instalado (ej. en pruebas), seguimos con las
// variables de entorno que ya estén definidas en el proceso.
try {
  require('dotenv').config();
} catch (err) {
  // no-op
}

// El organization_name es fijo para todas las empresas/consultas.
const ORGANIZATION_NAME = process.env.COPILOTO_ORG_NAME;
if (!ORGANIZATION_NAME) {
  throw new Error('Falta COPILOTO_ORG_NAME en las variables de entorno (.env).');
}

// La API key SÍ cambia por empresa. Se guarda como JSON en una sola variable
// de entorno para no tener que declarar una env var por cada empresa nueva:
//   COPILOTO_EMPRESA_API_KEYS='{"empresa_a":"MjA0MA==_...", "empresa_b":"..."}'
let empresaApiKeys = {};
try {
  empresaApiKeys = JSON.parse(process.env.COPILOTO_EMPRESA_API_KEYS || '{}');
} catch (err) {
  throw new Error(
    'COPILOTO_EMPRESA_API_KEYS debe ser un JSON válido: {"empresaId": "apiKey", ...}'
  );
}

function getApiKeyForEmpresa(empresaId) {
  const key = empresaApiKeys[empresaId];
  if (!key) {
    throw new Error(`No hay API key configurada para la empresa "${empresaId}".`);
  }
  return key;
}

// IDs internos de las empresas configuradas (las claves del JSON en
// COPILOTO_EMPRESA_API_KEYS). El nombre "de verdad" para mostrar en el front
// se obtiene llamando a la API de Copiloto (organization.company.name).
function listEmpresaIds() {
  return Object.keys(empresaApiKeys);
}

module.exports = { ORGANIZATION_NAME, getApiKeyForEmpresa, listEmpresaIds };
