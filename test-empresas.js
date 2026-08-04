'use strict';

process.env.COPILOTO_ORG_NAME = 'org_test';
process.env.COPILOTO_EMPRESA_API_KEYS = JSON.stringify({
  empresa_ok: 'key_ok',
  empresa_rota: 'key_rota',
});

const assert = require('assert');
const copilotoClient = require('./copilotoClient');

copilotoClient.fetchOrganization = async ({ apiKey }) => {
  if (apiKey === 'key_ok') {
    return {
      nombre: 'BUSES ISKRA SPA',
      vehiculos: [
        { placa: 'SWHG77', imei: '863457052205604', vin: '9BM634074RB328911' },
        { placa: 'VSKP44', imei: '863238070320801', vin: '9BM634074SB358665' },
      ],
    };
  }
  throw new Error('Copiloto API (organization) respondió 401: unauthorized');
};

const { obtenerEmpresas } = require('./empresasHandler');

async function main() {
  const empresas = await obtenerEmpresas();

  assert.strictEqual(empresas.length, 2);

  const ok = empresas.find((e) => e.empresaId === 'empresa_ok');
  assert.strictEqual(ok.nombre, 'BUSES ISKRA SPA');
  assert.strictEqual(ok.vehiculos.length, 2);
  assert.strictEqual(ok.vehiculos[0].placa, 'SWHG77');
  assert.strictEqual(ok.error, undefined);
  console.log('Caso 1 OK: empresa válida ->', JSON.stringify(ok));

  const rota = empresas.find((e) => e.empresaId === 'empresa_rota');
  assert.strictEqual(rota.nombre, 'empresa_rota');
  assert.strictEqual(rota.vehiculos.length, 0);
  assert.ok(rota.error.includes('401'));
  console.log('Caso 2 OK: empresa con API key inválida no rompe la lista ->', rota.error);

  console.log('\nTodos los casos de prueba de empresasHandler pasaron correctamente.');
}

main().catch((err) => {
  console.error('FALLÓ el test:', err);
  process.exit(1);
});
