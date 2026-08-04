'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { obtenerRendimiento } = require('./rendimientoHandler');
const { obtenerEmpresas } = require('./empresasHandler');

function crearApp() {
  const app = express();
  app.use(cors());

  // Sirve el frontend (public/index.html) en la raíz del sitio.
  app.use(express.static(path.join(__dirname, 'public')));

  // GET /api/empresas -> lista de empresas configuradas con su nombre real y vehículos
  app.get('/api/empresas', async (req, res) => {
    try {
      const resultado = await obtenerEmpresas();
      res.json(resultado);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/rendimiento?empresa=xxx&placas=ABC123,DEF456&desde=ISO&hasta=ISO
  app.get('/api/rendimiento', async (req, res) => {
    try {
      const resultado = await obtenerRendimiento(req.query);
      res.json(resultado);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message });
    }
  });

  return app;
}

module.exports = crearApp;
