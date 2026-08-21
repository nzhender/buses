'use strict';

const copilotoClient = require('./copilotoClient');
const config = require('./config');
const {
  calcularRendimiento,
  calcularRendimientoPorViaje,
  agregarFlota,
  calcularMejorDia,
  calcularMejorViaje,
} = require('./rendimiento');

// Mínimo de km para que un viaje individual califique como candidato a
// "mejor viaje" del comparativo de flota (evita que viajes muy cortos, con
// km/L poco representativo, ganen el destacado). Definido con el usuario.
const KM_MINIMO_MEJOR_VIAJE = 50;

const MAX_DIAS = 5;

/** Error de validación de entrada -> el caller debe responder 400. */
class ErrorValidacion extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.name = 'ErrorValidacion';
  }
}

/**
 * Lógica de negocio del endpoint de rendimiento, independiente del framework
 * HTTP (Express) para poder probarla sin levantar un servidor real.
 *
 * @param {{empresa: string, placas: string, desde: string, hasta: string}} params
 */
async function obtenerRendimiento({ empresa, placas, desde, hasta }) {
  if (!empresa || !placas || !desde || !hasta) {
    throw new ErrorValidacion('Faltan parámetros: empresa, placas, desde, hasta.');
  }

  const desdeMs = new Date(desde).getTime();
  const hastaMs = new Date(hasta).getTime();
  if (Number.isNaN(desdeMs) || Number.isNaN(hastaMs) || hastaMs <= desdeMs) {
    throw new ErrorValidacion('Rango de fechas inválido.');
  }

  const dias = (hastaMs - desdeMs) / (1000 * 60 * 60 * 24);
  if (dias > MAX_DIAS) {
    throw new ErrorValidacion(`El rango máximo permitido es de ${MAX_DIAS} días.`);
  }

  const apiKey = config.getApiKeyForEmpresa(empresa);
  const listaPlacas = String(placas)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (listaPlacas.length === 0) {
    throw new ErrorValidacion('Debe indicar al menos una placa.');
  }

  const resultadosPorVehiculo = await Promise.all(
    listaPlacas.map(async (placa) => {
      const eventos = await copilotoClient.fetchEventos({
        apiKey,
        licensePlate: placa,
        from: desde,
        to: hasta,
      });

      const rendimiento = calcularRendimiento(eventos, { desde, hasta });
      const viajes = calcularRendimientoPorViaje(eventos, { desde, hasta });

      // Serie liviana de velocidad para graficar en el front (solo timestamp + velocidad).
      const serieVelocidad = eventos
        .filter((e) => e.gps_utc_time)
        .map((e) => ({ t: e.gps_utc_time, v: e.speed }));

      // eventos crudos se guardan temporalmente para el comparativo de
      // flota (mejor día / mejor viaje); se descartan antes de responder,
      // no deben viajar completos en la respuesta de la API.
      return { placa, eventos, ...rendimiento, viajes, serieVelocidad };
    })
  );

  const eventosPorVehiculo = resultadosPorVehiculo.map((r) => ({ placa: r.placa, eventos: r.eventos }));

  const mejorDia = calcularMejorDia(eventosPorVehiculo, { desde, hasta });
  const mejorViaje = calcularMejorViaje(eventosPorVehiculo, { desde, hasta, kmMinimo: KM_MINIMO_MEJOR_VIAJE });

  const candidatosMejorVehiculo = resultadosPorVehiculo.filter((r) => r.rendimientoKmPorLitro !== null);
  const mejorVehiculoRaw = candidatosMejorVehiculo.length > 0
    ? candidatosMejorVehiculo.reduce((a, b) => (b.rendimientoKmPorLitro > a.rendimientoKmPorLitro ? b : a))
    : null;
  const mejorVehiculo = mejorVehiculoRaw
    ? {
        placa: mejorVehiculoRaw.placa,
        kmRecorridos: mejorVehiculoRaw.kmRecorridos,
        litrosConsumidos: mejorVehiculoRaw.litrosConsumidos,
        rendimientoKmPorLitro: mejorVehiculoRaw.rendimientoKmPorLitro,
      }
    : null;

  // resultadosLimpios: mismo array de siempre, sin el campo eventos (crudo).
  const resultadosLimpios = resultadosPorVehiculo.map(({ eventos, ...resto }) => resto);

  const flota = agregarFlota(resultadosLimpios);

  return {
    empresa,
    desde,
    hasta,
    vehiculos: resultadosLimpios,
    flota,
    comparativo: {
      mejorDia,
      mejorVehiculo,
      mejorViaje,
      kmMinimoMejorViaje: KM_MINIMO_MEJOR_VIAJE,
    },
  };
}

module.exports = { obtenerRendimiento, ErrorValidacion };
