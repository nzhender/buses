'use strict';

/**
 * Cálculo de rendimiento de combustible (km/L) para buses, a partir de
 * eventos de telemetría de la API de Copiloto (api.copiloto.ai).
 *
 * Campos usados de cada evento (confirmados con una respuesta real de la API):
 *  - gps_utc_time:     string ISO 8601, timestamp del evento (por GPS ping)
 *  - odometer:         número, km acumulados. Contador de por vida del vehículo,
 *                       NO se resetea entre viajes (verificado con datos reales).
 *  - odoliter:         número, litros de combustible acumulados consumidos.
 *                       Contador de por vida, tampoco se resetea entre viajes.
 *  - fuel_consumption: número, litros consumidos en el viaje ACTUAL. Se resetea
 *                       a un valor bajo/0 cada vez que inicia un nuevo viaje.
 *
 * Por qué el cálculo se basa en odometer/odoliter y no en fuel_consumption:
 * fuel_consumption es un contador por viaje, útil para desglose por viaje y como
 * control de calidad, pero no sirve como base única del rendimiento de un rango
 * de fechas porque se reinicia constantemente. odometer/odoliter, al ser
 * contadores acumulados de por vida, dan la diferencia real y precisa entre dos
 * fechas sin necesidad de sumar viaje por viaje.
 *
 * Notas de calidad de datos observadas en respuestas reales de la API:
 *  - latitude/longitude pueden venir en 0,0 cuando se pierde señal GPS, pero
 *    odometer/odoliter se siguen reportando con normalidad (no afecta el cálculo).
 *  - fuel_level (nivel de tanque %) es muy ruidoso (sube y baja bruscamente por
 *    el vaivén del combustible en el tanque) — NO usar para calcular rendimiento.
 *  - horometer (horas de motor) se resetea con frecuencia (aparentemente por
 *    evento del dispositivo), a diferencia de odometer/odoliter — no se usa aquí.
 */

function toEpoch(evt) {
  return new Date(evt.gps_utc_time).getTime();
}

/** Ordena eventos por timestamp ascendente (no asumimos que la API los entregue ordenados). */
function ordenarPorTiempo(eventos) {
  return [...eventos].sort((a, b) => toEpoch(a) - toEpoch(b));
}

/** Filtra eventos dentro de un rango [desde, hasta] (ISO strings o Date). */
function filtrarPorRango(eventos, desde, hasta) {
  const desdeMs = new Date(desde).getTime();
  const hastaMs = new Date(hasta).getTime();
  return eventos.filter((e) => {
    const t = toEpoch(e);
    return t >= desdeMs && t <= hastaMs;
  });
}

/**
 * Calcula el rendimiento (km/L) de UN vehículo en un rango de fechas, usando la
 * diferencia entre el primer y último registro válido del rango. Detecta resets
 * de contador (si odometer u odoliter bajan en vez de subir) y parte el cálculo
 * en segmentos para no arrastrar el error de un reinicio de equipo.
 *
 * @param {Array<Object>} eventos - eventos crudos del vehículo (sin filtrar/ordenar)
 * @param {{desde: string, hasta: string}} rango
 * @returns {{
 *   kmRecorridos: number,
 *   litrosConsumidos: number,
 *   rendimientoKmPorLitro: number|null,
 *   muestras: number,
 *   segmentos: number,
 *   primerRegistro: string|null,
 *   ultimoRegistro: string|null,
 *   advertencias: string[]
 * }}
 */
function calcularRendimiento(eventos, { desde, hasta }) {
  const advertencias = [];
  const enRango = filtrarPorRango(ordenarPorTiempo(eventos), desde, hasta);

  if (enRango.length === 0) {
    return {
      kmRecorridos: 0,
      litrosConsumidos: 0,
      rendimientoKmPorLitro: null,
      velocidadPromedio: null,
      muestrasVelocidad: 0,
      sumaVelocidad: 0,
      muestras: 0,
      segmentos: 0,
      primerRegistro: null,
      ultimoRegistro: null,
      advertencias: ['Sin datos de telemetría en el rango solicitado.'],
    };
  }

  let kmTotal = 0;
  let litrosTotal = 0;
  let segmentos = 1;
  let inicioSegmento = enRango[0];

  for (let i = 1; i < enRango.length; i++) {
    const anterior = enRango[i - 1];
    const actual = enRango[i];

    const resetOdometro = actual.odometer < anterior.odometer;
    const resetOdolitro = actual.odoliter < anterior.odoliter;

    if (resetOdometro || resetOdolitro) {
      kmTotal += anterior.odometer - inicioSegmento.odometer;
      litrosTotal += anterior.odoliter - inicioSegmento.odoliter;
      advertencias.push(
        `Reset de contador detectado en ${actual.gps_utc_time} (posible cambio de equipo o reinicio de firmware).`
      );
      inicioSegmento = actual;
      segmentos += 1;
    }
  }

  const ultimo = enRango[enRango.length - 1];
  kmTotal += ultimo.odometer - inicioSegmento.odometer;
  litrosTotal += ultimo.odoliter - inicioSegmento.odoliter;

  const rendimiento = litrosTotal > 0 ? kmTotal / litrosTotal : null;
  if (litrosTotal <= 0) {
    advertencias.push('No hubo consumo de combustible registrado en el rango; rendimiento indefinido.');
  }

  // Velocidad promedio: media simple de "speed" sobre los eventos válidos del
  // rango (por evento/GPS ping, misma granularidad que serieVelocidad).
  const velocidadesValidas = enRango
    .map((e) => e.speed)
    .filter((v) => typeof v === 'number' && !Number.isNaN(v));
  const sumaVelocidad = velocidadesValidas.reduce((acc, v) => acc + v, 0);
  const muestrasVelocidad = velocidadesValidas.length;
  const velocidadPromedio = muestrasVelocidad > 0 ? Number((sumaVelocidad / muestrasVelocidad).toFixed(1)) : null;

  return {
    kmRecorridos: Number(kmTotal.toFixed(2)),
    litrosConsumidos: Number(litrosTotal.toFixed(2)),
    rendimientoKmPorLitro: rendimiento !== null ? Number(rendimiento.toFixed(3)) : null,
    velocidadPromedio,
    muestrasVelocidad,
    sumaVelocidad: Number(sumaVelocidad.toFixed(1)),
    muestras: enRango.length,
    segmentos,
    primerRegistro: enRango[0].gps_utc_time,
    ultimoRegistro: ultimo.gps_utc_time,
    advertencias,
  };
}

/**
 * Desglosa el rendimiento por viaje individual, usando fuel_consumption (se
 * resetea al iniciar un viaje) para detectar el límite entre viajes. Sirve para:
 *  1) Mostrar "este viaje rindió X km/L".
 *  2) Control de calidad: compara litros según odoliter vs. litros según
 *     fuel_consumption; una diferencia grande indica pings perdidos o un viaje
 *     mal cerrado.
 */
function calcularRendimientoPorViaje(eventos, { desde, hasta }) {
  const enRango = filtrarPorRango(ordenarPorTiempo(eventos), desde, hasta);
  if (enRango.length === 0) return [];

  const viajes = [];
  let viajeActual = [enRango[0]];

  for (let i = 1; i < enRango.length; i++) {
    const anterior = enRango[i - 1];
    const actual = enRango[i];
    const nuevoViaje = actual.fuel_consumption < anterior.fuel_consumption;
    if (nuevoViaje) {
      viajes.push(viajeActual);
      viajeActual = [actual];
    } else {
      viajeActual.push(actual);
    }
  }
  viajes.push(viajeActual);

  return viajes.map((eventosViaje) => {
    const inicio = eventosViaje[0];
    const fin = eventosViaje[eventosViaje.length - 1];
    const km = Number((fin.odometer - inicio.odometer).toFixed(2));
    const litrosOdolitro = Number((fin.odoliter - inicio.odoliter).toFixed(2));
    const litrosFuelConsumption = Number((fin.fuel_consumption || 0).toFixed(2));
    const diferenciaControlCalidad = Number((litrosOdolitro - litrosFuelConsumption).toFixed(2));

    return {
      inicio: inicio.gps_utc_time,
      fin: fin.gps_utc_time,
      kmRecorridos: km,
      litrosSegunOdolitro: litrosOdolitro,
      litrosSegunFuelConsumption: litrosFuelConsumption,
      diferenciaControlCalidad,
      rendimientoKmPorLitro: litrosOdolitro > 0 ? Number((km / litrosOdolitro).toFixed(3)) : null,
      muestras: eventosViaje.length,
    };
  });
}

/**
 * Agrega el rendimiento de varios vehículos (nivel empresa) sumando km y litros
 * primero, NO promediando los rendimientos individuales de cada vehículo.
 */
function agregarFlota(resultadosPorVehiculo) {
  const kmTotal = resultadosPorVehiculo.reduce((acc, r) => acc + r.kmRecorridos, 0);
  const litrosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + r.litrosConsumidos, 0);

  // Velocidad promedio de flota: se pondera por cantidad de muestras de cada
  // vehículo (no es el promedio simple de los promedios individuales), para
  // que un vehículo con más registros pese más en el resultado.
  const sumaVelocidadTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.sumaVelocidad || 0), 0);
  const muestrasVelocidadTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.muestrasVelocidad || 0), 0);

  return {
    kmRecorridos: Number(kmTotal.toFixed(2)),
    litrosConsumidos: Number(litrosTotal.toFixed(2)),
    rendimientoKmPorLitro: litrosTotal > 0 ? Number((kmTotal / litrosTotal).toFixed(3)) : null,
    velocidadPromedio: muestrasVelocidadTotal > 0 ? Number((sumaVelocidadTotal / muestrasVelocidadTotal).toFixed(1)) : null,
    vehiculos: resultadosPorVehiculo.length,
  };
}

module.exports = {
  calcularRendimiento,
  calcularRendimientoPorViaje,
  agregarFlota,
};
