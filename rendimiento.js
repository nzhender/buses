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

// Ralentí: motor encendido en marcha mínima sin desplazamiento (RPM entre 500
// y 620, velocidad 0). Definición confirmada con el usuario.
const RALENTI_RPM_MIN = 500;
const RALENTI_RPM_MAX = 620;

// Conducción rentable: el motor trabaja en el rango de RPM donde el consumo
// de combustible rinde mejor (650-1850) Y el vehículo está efectivamente en
// movimiento (>1 km/h, para no contar RPM alto con el bus detenido, ej.
// acelerando en neutro). Definición confirmada con el usuario.
const CONDUCCION_RENTABLE_RPM_MIN = 650;
const CONDUCCION_RENTABLE_RPM_MAX = 1850;
const CONDUCCION_RENTABLE_VELOCIDAD_MIN = 1;

// Conducción NO rentable: motor sobre-revolucionado (RPM > 1900) con el
// vehículo en movimiento (>1 km/h) — desgasta el motor y gasta más
// combustible del necesario. Definición confirmada con el usuario. Nota: el
// tramo 1850-1900 queda deliberadamente fuera de ambas categorías (zona de
// transición, ni "rentable" ni "no rentable").
const CONDUCCION_NO_RENTABLE_RPM_MIN = 1900;
const CONDUCCION_NO_RENTABLE_VELOCIDAD_MIN = 1;

// Aceleración en vacío: el motor se acelera por sobre 660 RPM con el
// vehículo completamente detenido (velocidad 0) — típicamente el conductor
// "pisando el acelerador" sin desplazamiento, distinto del ralentí normal
// (500-620 RPM en marcha mínima). Definición confirmada con el usuario.
const ACELERACION_VACIO_RPM_MIN = 660;

// Horas de motor: tiempo total con el motor encendido (RPM > 0),
// independiente de la velocidad. Se calcula aparte de las 4 categorías de
// ralentí/aceleración en vacío/conducción rentable/no rentable, porque esas
// 4 categorías tienen "huecos" entre sí (ej. velocidad entre 0 y 1 km/h, o
// RPM en zonas de transición) que no reflejan cuándo el motor está apagado,
// sino solo cuándo no cae en ninguna categoría específica. Sumar solo esas
// 4 subestimaría las horas reales de motor encendido.
const MOTOR_ENCENDIDO_RPM_MIN = 0;

function esMotorEncendido(evento) {
  return typeof evento.rpm === 'number' && evento.rpm > MOTOR_ENCENDIDO_RPM_MIN;
}

// Si entre dos eventos consecutivos hay un hueco de datos mayor a esto, no se
// cuenta ese intervalo como ralentí ni como conducción rentable (evita
// inflar el tiempo por pérdida de señal o equipo apagado, donde no hay forma
// de saber qué pasó realmente).
const HUECO_MAXIMO_MS = 10 * 60 * 1000;
// Alias retrocompatible (usado más abajo en calcularRalentiMinutos).
const RALENTI_HUECO_MAXIMO_MS = HUECO_MAXIMO_MS;

function esRalenti(evento) {
  return (
    typeof evento.rpm === 'number' &&
    evento.rpm >= RALENTI_RPM_MIN &&
    evento.rpm <= RALENTI_RPM_MAX &&
    evento.speed === 0
  );
}

function esConduccionRentable(evento) {
  return (
    typeof evento.rpm === 'number' &&
    evento.rpm >= CONDUCCION_RENTABLE_RPM_MIN &&
    evento.rpm <= CONDUCCION_RENTABLE_RPM_MAX &&
    typeof evento.speed === 'number' &&
    evento.speed > CONDUCCION_RENTABLE_VELOCIDAD_MIN
  );
}

function esConduccionNoRentable(evento) {
  return (
    typeof evento.rpm === 'number' &&
    evento.rpm > CONDUCCION_NO_RENTABLE_RPM_MIN &&
    typeof evento.speed === 'number' &&
    evento.speed > CONDUCCION_NO_RENTABLE_VELOCIDAD_MIN
  );
}

function esAceleracionVacio(evento) {
  return (
    typeof evento.rpm === 'number' &&
    evento.rpm > ACELERACION_VACIO_RPM_MIN &&
    evento.speed === 0
  );
}

/**
 * Suma minutos donde se cumple una condición por-evento (ralentí, conducción
 * rentable, etc.), asumiendo que el estado se mantiene hasta el próximo ping.
 * Comparte la misma lógica de exclusión de huecos de datos que el ralentí.
 */
function sumarMinutosPorCondicion(enRango, condicionFn, advertencias, etiquetaAdvertencia) {
  let totalMs = 0;
  let huecosIgnorados = 0;

  for (let i = 0; i < enRango.length - 1; i++) {
    const actual = enRango[i];
    const siguiente = enRango[i + 1];
    if (!condicionFn(actual)) continue;

    const deltaMs = toEpoch(siguiente) - toEpoch(actual);
    if (deltaMs <= 0) continue;

    if (deltaMs > HUECO_MAXIMO_MS) {
      huecosIgnorados += 1;
      continue;
    }

    totalMs += deltaMs;
  }

  if (huecosIgnorados > 0 && advertencias && etiquetaAdvertencia) {
    advertencias.push(
      `Se ignoraron ${huecosIgnorados} hueco(s) de datos mayores a 10 minutos en el cálculo de ${etiquetaAdvertencia}.`
    );
  }

  return Number((totalMs / 60000).toFixed(1));
}

/**
 * Suma el tiempo en ralentí dentro de una lista de eventos ya ordenados y
 * filtrados por rango. Para cada evento que cumple la condición de ralentí,
 * se cuenta el tiempo hasta el siguiente evento (se asume que el estado se
 * mantuvo hasta el próximo ping).
 */
function calcularRalentiMinutos(enRango, advertencias) {
  return sumarMinutosPorCondicion(
    enRango,
    esRalenti,
    advertencias,
    'ralentí (posible pérdida de señal o equipo apagado)'
  );
}

/**
 * Suma el tiempo en conducción rentable (RPM 650-1850 con velocidad > 1
 * km/h) dentro de una lista de eventos ya ordenados y filtrados por rango.
 */
function calcularConduccionRentableMinutos(enRango, advertencias) {
  return sumarMinutosPorCondicion(
    enRango,
    esConduccionRentable,
    advertencias,
    'conducción rentable (posible pérdida de señal o equipo apagado)'
  );
}

/**
 * Suma el tiempo en conducción NO rentable (RPM > 1900 con velocidad > 1
 * km/h) dentro de una lista de eventos ya ordenados y filtrados por rango.
 */
function calcularConduccionNoRentableMinutos(enRango, advertencias) {
  return sumarMinutosPorCondicion(
    enRango,
    esConduccionNoRentable,
    advertencias,
    'conducción no rentable (posible pérdida de señal o equipo apagado)'
  );
}

/**
 * Suma el tiempo en aceleración en vacío (RPM > 660 con velocidad 0) dentro
 * de una lista de eventos ya ordenados y filtrados por rango.
 */
function calcularAceleracionVacioMinutos(enRango, advertencias) {
  return sumarMinutosPorCondicion(
    enRango,
    esAceleracionVacio,
    advertencias,
    'aceleración en vacío (posible pérdida de señal o equipo apagado)'
  );
}

/**
 * Suma el tiempo total con el motor encendido (RPM > 0), sin importar la
 * velocidad. Calculado de forma independiente a ralentí/aceleración en
 * vacío/conducción rentable/no rentable (ver nota en MOTOR_ENCENDIDO_RPM_MIN).
 */
function calcularHorasMotorMinutos(enRango, advertencias) {
  return sumarMinutosPorCondicion(
    enRango,
    esMotorEncendido,
    advertencias,
    'horas de motor (posible pérdida de señal o equipo apagado)'
  );
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
/**
 * Suma km recorridos y litros consumidos de una lista de eventos YA
 * ordenados y filtrados (de UN vehículo), detectando resets de contador
 * (odometer/odoliter bajan en vez de subir) y partiendo el cálculo en
 * segmentos para no arrastrar el error de un reinicio de equipo. Compartida
 * entre calcularRendimiento (rango completo) y calcularMejorDia (por día).
 */
function calcularKmYLitros(enRango, advertencias) {
  if (enRango.length === 0) return { kmTotal: 0, litrosTotal: 0, segmentos: 0 };

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
      if (advertencias) {
        advertencias.push(
          `Reset de contador detectado en ${actual.gps_utc_time} (posible cambio de equipo o reinicio de firmware).`
        );
      }
      inicioSegmento = actual;
      segmentos += 1;
    }
  }

  const ultimo = enRango[enRango.length - 1];
  kmTotal += ultimo.odometer - inicioSegmento.odometer;
  litrosTotal += ultimo.odoliter - inicioSegmento.odoliter;

  return { kmTotal, litrosTotal, segmentos };
}

function calcularRendimiento(eventos, { desde, hasta }) {
  const advertencias = [];
  const enRango = filtrarPorRango(ordenarPorTiempo(eventos), desde, hasta);

  if (enRango.length === 0) {
    return {
      kmRecorridos: 0,
      litrosConsumidos: 0,
      rendimientoKmPorLitro: null,
      velocidadPromedio: null,
      velocidadMaxima: null,
      muestrasVelocidad: 0,
      sumaVelocidad: 0,
      ralentiMinutos: 0,
      conduccionRentableMinutos: 0,
      conduccionNoRentableMinutos: 0,
      aceleracionVacioMinutos: 0,
      horasMotorMinutos: 0,
      muestras: 0,
      segmentos: 0,
      primerRegistro: null,
      ultimoRegistro: null,
      advertencias: ['Sin datos de telemetría en el rango solicitado.'],
    };
  }

  const { kmTotal, litrosTotal, segmentos } = calcularKmYLitros(enRango, advertencias);

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

  const ralentiMinutos = calcularRalentiMinutos(enRango, advertencias);
  const conduccionRentableMinutos = calcularConduccionRentableMinutos(enRango, advertencias);
  const conduccionNoRentableMinutos = calcularConduccionNoRentableMinutos(enRango, advertencias);
  const aceleracionVacioMinutos = calcularAceleracionVacioMinutos(enRango, advertencias);
  const horasMotorMinutos = calcularHorasMotorMinutos(enRango, advertencias);

  const velocidadMaxima = velocidadesValidas.length > 0 ? Math.max(...velocidadesValidas) : null;

  return {
    kmRecorridos: Number(kmTotal.toFixed(2)),
    litrosConsumidos: Number(litrosTotal.toFixed(2)),
    rendimientoKmPorLitro: rendimiento !== null ? Number(rendimiento.toFixed(3)) : null,
    velocidadPromedio,
    velocidadMaxima,
    muestrasVelocidad,
    sumaVelocidad: Number(sumaVelocidad.toFixed(1)),
    ralentiMinutos,
    conduccionRentableMinutos,
    conduccionNoRentableMinutos,
    aceleracionVacioMinutos,
    horasMotorMinutos,
    muestras: enRango.length,
    segmentos,
    primerRegistro: enRango[0].gps_utc_time,
    ultimoRegistro: enRango[enRango.length - 1].gps_utc_time,
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
/**
 * Una coordenada 0,0 no es una ubicación real: es la señal de que el GPS
 * perdió cobertura en ese momento (ver notas de calidad de datos arriba).
 * Se descarta en vez de mostrarla como si fuera una ubicación válida.
 */
function coordenadaValida(evento) {
  if (typeof evento.latitude !== 'number' || typeof evento.longitude !== 'number') return false;
  if (evento.latitude === 0 && evento.longitude === 0) return false;
  return true;
}

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
      coordenadaInicio: coordenadaValida(inicio) ? { lat: inicio.latitude, lon: inicio.longitude } : null,
      coordenadaFin: coordenadaValida(fin) ? { lat: fin.latitude, lon: fin.longitude } : null,
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
  const ralentiMinutosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.ralentiMinutos || 0), 0);
  const conduccionRentableMinutosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.conduccionRentableMinutos || 0), 0);
  const conduccionNoRentableMinutosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.conduccionNoRentableMinutos || 0), 0);
  const aceleracionVacioMinutosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.aceleracionVacioMinutos || 0), 0);
  const horasMotorMinutosTotal = resultadosPorVehiculo.reduce((acc, r) => acc + (r.horasMotorMinutos || 0), 0);

  const velocidadesMaximas = resultadosPorVehiculo
    .map((r) => r.velocidadMaxima)
    .filter((v) => typeof v === 'number' && !Number.isNaN(v));
  const velocidadMaxima = velocidadesMaximas.length > 0 ? Math.max(...velocidadesMaximas) : null;

  return {
    kmRecorridos: Number(kmTotal.toFixed(2)),
    litrosConsumidos: Number(litrosTotal.toFixed(2)),
    rendimientoKmPorLitro: litrosTotal > 0 ? Number((kmTotal / litrosTotal).toFixed(3)) : null,
    velocidadPromedio: muestrasVelocidadTotal > 0 ? Number((sumaVelocidadTotal / muestrasVelocidadTotal).toFixed(1)) : null,
    velocidadMaxima,
    ralentiMinutos: Number(ralentiMinutosTotal.toFixed(1)),
    conduccionRentableMinutos: Number(conduccionRentableMinutosTotal.toFixed(1)),
    conduccionNoRentableMinutos: Number(conduccionNoRentableMinutosTotal.toFixed(1)),
    aceleracionVacioMinutos: Number(aceleracionVacioMinutosTotal.toFixed(1)),
    horasMotorMinutos: Number(horasMotorMinutosTotal.toFixed(1)),
    vehiculos: resultadosPorVehiculo.length,
  };
}

/**
 * Clave de agrupación por día calendario, a partir del timestamp UTC del
 * evento (los primeros 10 caracteres de un ISO 8601 son 'YYYY-MM-DD').
 * Nota: agrupa por fecha UTC, no por fecha local de Chile — en el borde de
 * medianoche un viaje podría quedar contado en el día "equivocado" en hora
 * local, pero es consistente y suficiente para comparar días entre sí.
 */
function claveDia(evento) {
  return evento.gps_utc_time.slice(0, 10);
}

/**
 * "Mejor día": cruza TODOS los vehículos seleccionados, agrupa sus eventos
 * por día calendario, suma km y litros de todos los vehículos ese día, y
 * devuelve el día con mejor km/L de flota. Días sin consumo de combustible
 * registrado no califican (rendimiento indefinido).
 *
 * @param {Array<{placa: string, eventos: Array<Object>}>} eventosPorVehiculo
 * @returns {{fecha: string, kmRecorridos: number, litrosConsumidos: number, rendimientoKmPorLitro: number} | null}
 */
function calcularMejorDia(eventosPorVehiculo, { desde, hasta }) {
  const acumuladoPorDia = {};

  eventosPorVehiculo.forEach(({ eventos }) => {
    const enRango = filtrarPorRango(ordenarPorTiempo(eventos), desde, hasta);

    const eventosPorDiaDeEsteVehiculo = {};
    enRango.forEach((evento) => {
      const dia = claveDia(evento);
      if (!eventosPorDiaDeEsteVehiculo[dia]) eventosPorDiaDeEsteVehiculo[dia] = [];
      eventosPorDiaDeEsteVehiculo[dia].push(evento);
    });

    Object.keys(eventosPorDiaDeEsteVehiculo).forEach((dia) => {
      // calcularKmYLitros necesita >=1 evento para dar un delta con sentido;
      // con un solo evento en el día no hay delta que calcular, se omite.
      if (eventosPorDiaDeEsteVehiculo[dia].length < 2) return;
      const { kmTotal, litrosTotal } = calcularKmYLitros(eventosPorDiaDeEsteVehiculo[dia]);
      if (!acumuladoPorDia[dia]) acumuladoPorDia[dia] = { kmTotal: 0, litrosTotal: 0 };
      acumuladoPorDia[dia].kmTotal += kmTotal;
      acumuladoPorDia[dia].litrosTotal += litrosTotal;
    });
  });

  let mejor = null;
  Object.keys(acumuladoPorDia).forEach((dia) => {
    const { kmTotal, litrosTotal } = acumuladoPorDia[dia];
    if (litrosTotal <= 0) return;
    const rendimientoKmPorLitro = kmTotal / litrosTotal;
    if (!mejor || rendimientoKmPorLitro > mejor.rendimientoKmPorLitro) {
      mejor = {
        fecha: dia,
        kmRecorridos: Number(kmTotal.toFixed(2)),
        litrosConsumidos: Number(litrosTotal.toFixed(2)),
        rendimientoKmPorLitro: Number(rendimientoKmPorLitro.toFixed(3)),
      };
    }
  });

  return mejor;
}

/**
 * "Mejor viaje": cruza TODOS los vehículos seleccionados y todos sus viajes
 * individuales (ver calcularRendimientoPorViaje), y devuelve el de mejor
 * km/L entre los que cumplen un mínimo de kilómetros — para no premiar
 * viajes muy cortos donde el km/L es poco representativo (ruido de datos).
 *
 * @param {Array<{placa: string, eventos: Array<Object>}>} eventosPorVehiculo
 * @param {{desde: string, hasta: string, kmMinimo: number}} opciones
 */
function calcularMejorViaje(eventosPorVehiculo, { desde, hasta, kmMinimo }) {
  let mejor = null;

  eventosPorVehiculo.forEach(({ placa, eventos }) => {
    const viajes = calcularRendimientoPorViaje(eventos, { desde, hasta });
    viajes.forEach((viaje) => {
      if (viaje.kmRecorridos < kmMinimo) return;
      if (viaje.rendimientoKmPorLitro === null) return;
      if (!mejor || viaje.rendimientoKmPorLitro > mejor.rendimientoKmPorLitro) {
        mejor = Object.assign({ placa }, viaje);
      }
    });
  });

  return mejor;
}

module.exports = {
  calcularRendimiento,
  calcularRendimientoPorViaje,
  agregarFlota,
  calcularMejorDia,
  calcularMejorViaje,
};
