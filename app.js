'use strict';

const express = require('express');
const cors = require('cors');
const { obtenerRendimiento } = require('./rendimientoHandler');

function crearApp() {
  const app = express();
  app.use(cors());

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
