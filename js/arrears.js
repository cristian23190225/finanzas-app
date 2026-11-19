/* =========================================================
   arrears.js
   Cálculo de ATRASOS y ADELANTOS, igual para préstamos (cobros de
   interés) y deudas (pagos). No toca la pantalla ni los datos.

   Cada préstamo/deuda guarda tres datos:
     closed  = cuántos periodos ya están "cerrados" (cobrados/pagados,
               o pasados al atrasado). El próximo cobro sale de aquí.
     backlog = dinero ATRASADO (no es una cuenta de cobros: es dinero).
     credit  = dinero a favor que sobró al adelantar pagos (menos de 1 periodo).

   Reglas:
     - "Del día" = el periodo más reciente que ya venció. Al cobrarlo,
       el próximo cobro salta al siguiente periodo (aunque haya atrasos).
     - Los periodos más viejos que no se cobraron pasan a "atrasado".
       Cobrar atrasado NO mueve la fecha del próximo cobro.
     - Cuántos cobros atrasados son = atrasado ÷ lo de cada periodo,
       redondeado hacia arriba (350 ÷ 200 = 2: uno de 200 y uno de 150).
     - Si te dan más del periodo estando al día, se adelantan periodos:
       400 con cobros de 200 = 2 periodos adelantados; lo que sobre
       (menos de 1 periodo) queda a favor para el siguiente.
     - Si te dan menos del periodo del día, el día se cierra y la
       diferencia pasa a atrasado.
   ========================================================= */

import { roundMoney } from './utils.js';

const TOLERANCE = 1e-9;

/** Lo máximo que se puede adelantar de una sola vez (periodos). */
export const MAX_AHEAD = 24;

/**
 * Pasa a "atrasado" los periodos viejos que no se cobraron (todos menos el más reciente).
 * Devuelve el estado ya acomodado y cuántos periodos pasaron: { closed, backlog, credit, rolled }.
 */
export function settle(state, elapsed, per) {
  const rolled = Math.max(0, elapsed - state.closed - 1);
  const owed = rolled * per;
  const used = Math.min(state.credit, owed); // el dinero a favor cubre primero
  return {
    closed: state.closed + rolled,
    backlog: roundMoney(state.backlog + owed - used),
    credit: roundMoney(state.credit - used),
    rolled,
  };
}

/** De cuántos cobros/pagos se forma el atrasado: { lateCount, full, rest } (350 con cobros de 200 = 2: uno de 200 y uno de 150). */
export function lateParts(backlog, per) {
  if (!(backlog > 0) || !(per > 0)) return { lateCount: 0, full: 0, rest: roundMoney(Math.max(0, backlog || 0)) };
  const full = Math.floor(backlog / per + TOLERANCE);
  return { lateCount: Math.ceil(backlog / per - TOLERANCE), full, rest: roundMoney(backlog - full * per) };
}

/** Qué se ve hoy: atrasado, cobros atrasados, lo del día y de cuándo es el próximo cobro. */
export function view(state, elapsed, per) {
  const rolled = Math.max(0, elapsed - state.closed - 1);
  const owed = rolled * per;
  const used = Math.min(state.credit, owed);
  const backlog = roundMoney(state.backlog + owed - used);
  const credit = roundMoney(state.credit - used);

  const dayOpen = elapsed - state.closed >= 1; // el periodo más reciente todavía no se cierra
  const dayDue = dayOpen ? Math.max(0, roundMoney(per - credit)) : 0;

  return {
    backlog,
    credit,
    dayOpen,
    dayDue,
    // Número del periodo del próximo cobro (0 = el primero). Si el del día está abierto es el más reciente.
    nextIndex: dayOpen ? elapsed - 1 : state.closed,
    // Desde qué periodo hay atraso sin cobrar (si se conoce)
    oldestIndex: rolled > 0 ? state.closed : null,
    // Periodos ya cobrados por adelantado (más allá de hoy)
    ahead: Math.max(0, state.closed - elapsed),
    ...lateParts(backlog, per), // lateCount, full (cobros completos) y rest (un cobro más, de menos dinero)
  };
}

/**
 * Se cobra/paga el periodo del día (y, si sobra dinero, se adelantan periodos).
 * Devuelve el nuevo estado y "periods" = cuántos periodos se cerraron (incluye los que pasaron a atrasado).
 */
export function payDay(state, elapsed, per, amount) {
  const s = settle(state, elapsed, per);
  const pool = roundMoney(amount + s.credit);
  const full = Math.floor(pool / per + TOLERANCE);

  if (full >= 1) {
    return {
      closed: s.closed + full,
      backlog: s.backlog,
      credit: roundMoney(pool - full * per),
      periods: s.rolled + full,
    };
  }
  if (s.closed < elapsed) {
    // Menos de un periodo: el día queda cobrado y lo que faltó pasa a atrasado
    return {
      closed: s.closed + 1,
      backlog: roundMoney(s.backlog + (per - pool)),
      credit: 0,
      periods: s.rolled + 1,
    };
  }
  // Ya estaba al día y es menos de un periodo: queda a favor
  return { closed: s.closed, backlog: s.backlog, credit: pool, periods: s.rolled };
}

/** Se cobra/paga dinero atrasado. No mueve la fecha del próximo cobro. */
export function payLate(state, elapsed, per, amount) {
  const s = settle(state, elapsed, per);
  return {
    closed: s.closed,
    backlog: roundMoney(Math.max(0, s.backlog - amount)),
    credit: s.credit,
    periods: s.rolled,
  };
}

/** Lo máximo que se puede pagar en "del día" (el periodo y hasta MAX_AHEAD adelantados), menos lo que ya está a favor. */
export function maxDayAmount(state, elapsed, per) {
  const open = state.closed < elapsed ? 1 : 0; // si el del día ya está cobrado, solo se adelanta
  const aheadRoom = Math.max(0, MAX_AHEAD - Math.max(0, state.closed - elapsed));
  return roundMoney(Math.max(0, (open + aheadRoom) * per - state.credit));
}
