// =====================================================================
// VALIDADOR CONTRA EL HISTÓRICO DE GESTIÓN HUMANA
// Al subir el Excel de una unidad en "Cargue masivo", revisa cada cédula en el
// histórico del reporte GH (tabla reporte_gh_historico). Si ya figura afiliada en
// fechas que se cruzan con las del archivo, agrega a esa fila un AVISO
// ("YA ESTÁ AFILIADO…") con la unidad y las fechas. Es solo un aviso: la fila se
// puede guardar igual; si la cédula no aparece, no pasa nada.
//
// Archivo independiente: NO modifica app.js. Se engancha a dos funciones de la
// plataforma (procesarArchivoMasivo y validarFilaMasiva) y, si algo falla, deja
// todo funcionando como antes.
// =====================================================================
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- utilidades puras
  function normalizar(t) {
    return String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  }
  function fechaLegible(iso) {
    if (!iso) return "";
    const [a, m, d] = String(iso).slice(0, 10).split("-");
    return `${d}/${m}/${a}`;
  }
  function soloDigitos(v) { return String(v ?? "").replace(/\D/g, ""); }

  // ¿La afiliación que ya está en el histórico (h) se cruza con las fechas del registro nuevo?
  function seCruza(registro, h) {
    const iniN = registro.fecha_inicio_practica || registro.fecha_inicio_cobertura;
    const finN = registro.fecha_final_practica || null;
    const iniH = h.fecha_inicio_practica || null, finH = h.fecha_fin_practica || null;
    if (!iniN || (!iniH && !finH)) return false;          // sin fechas no se puede afirmar nada
    if (finH && finH < iniN) return false;                // la anterior ya había terminado cuando empieza la nueva
    if (finN && iniH && iniH > finN) return false;        // la anterior empieza después de que termina la nueva
    return true;
  }

  // registro = fila nueva del Excel; historial = filas del histórico con esa misma cédula
  // Devuelve { alerta, tipo, cantidad } ; alerta es null si no hay nada que avisar.
  function evaluarCoincidencias(registro, historial) {
    const cruzan = (historial || []).filter(h => seCruza(registro, h));
    if (cruzan.length === 0) return { alerta: null, tipo: null, cantidad: 0 };
    const mia = normalizar(registro.facultad_ur);
    const esMisma = (h) => mia !== "" && normalizar(h.facultad) === mia;
    cruzan.sort((a, b) => (esMisma(b) - esMisma(a)) || String(b.fecha_fin_practica || "").localeCompare(String(a.fecha_fin_practica || "")));
    const h = cruzan[0], misma = esMisma(h);
    const periodo = `del ${fechaLegible(h.fecha_inicio_practica) || "—"} al ${fechaLegible(h.fecha_fin_practica) || "—"}`;
    const cargue = h.fecha_cargue ? ` (cargue ${fechaLegible(h.fecha_cargue)})` : "";
    const mas = cruzan.length > 1 ? ` (+${cruzan.length - 1} más en el histórico)` : "";
    const donde = misma ? "en esta misma unidad" : "por otra unidad";
    return {
      tipo: misma ? "misma_unidad" : "otra_unidad", cantidad: cruzan.length,
      alerta: `YA ESTÁ AFILIADO ${donde} (${h.facultad || "sin unidad registrada"}): ${periodo}${cargue}${mas}. Revisar antes de enviar a AXA (se permite, pero verificar)`,
    };
  }

  // Lee del histórico todas las filas de las cédulas dadas (en bloques, para no armar direcciones larguísimas)
  async function leerHistorialPorCedulas(sb, cedulas) {
    const mapa = new Map(), tam = 120, bloques = [];
    for (let i = 0; i < cedulas.length; i += tam) bloques.push(cedulas.slice(i, i + tam));
    for (let i = 0; i < bloques.length; i += 4) {                       // hasta 4 consultas a la vez
      const res = await Promise.all(bloques.slice(i, i + 4).map(b => sb.from("reporte_gh_historico")
        .select("numero_documento, facultad, fecha_inicio_practica, fecha_fin_practica, fecha_cargue, observacion_cargue")
        .in("numero_documento", b)));
      for (const { data, error } of res) {
        if (error) throw new Error(error.message);
        for (const f of data) { const k = String(f.numero_documento); if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(f); }
      }
    }
    return mapa;
  }

  const api = { normalizar, seCruza, evaluarCoincidencias, leerHistorialPorCedulas };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ValidadorHistoricoGH = api;

  // =================================================================== ENGANCHE CON LA PLATAFORMA (solo en el navegador)
  if (typeof document === "undefined") return;
  if (typeof root.validarFilaMasiva !== "function" || typeof root.procesarArchivoMasivo !== "function") {
    console.warn("Validador histórico GH: no encontré las funciones del cargue masivo; no se activa.");
    return;
  }

  let historial = new Map();     // cédula -> filas del histórico (del archivo que se está revisando)

  // 1) Cada vez que la plataforma valida una fila, se agrega el aviso del histórico (si corresponde)
  const validarOriginal = root.validarFilaMasiva;
  root.validarFilaMasiva = function () {
    const errores = validarOriginal.apply(this, arguments);
    try {
      const registro = arguments[0];
      const r = evaluarCoincidencias(registro, historial.get(soloDigitos(registro.identificacion)) || []);
      if (r.alerta) errores.push(r.alerta);
    } catch (e) { console.warn("Validador histórico GH:", e); }
    return errores;
  };

  // 2) Cuando se sube un archivo: la plataforma lo procesa como siempre y después se revisa contra el histórico
  const procesarOriginal = root.procesarArchivoMasivo;
  root.procesarArchivoMasivo = async function () {
    const antes = filasMasivas;
    historial = new Map(); quitarBanner();
    await procesarOriginal.apply(this, arguments);
    if (filasMasivas === antes || filasMasivas.length === 0) return;      // el archivo no se procesó (columnas no reconocidas, etc.)
    await revisarContraHistorico();
  };

  function banner() {
    let el = document.getElementById("aviso-historico-gh");
    if (!el) {
      el = document.createElement("div"); el.id = "aviso-historico-gh"; el.className = "alerta-caja visible";
      el.style.cssText = "margin-top:10px";
      const resumen = document.getElementById("alerta-resumen-masivo");
      if (resumen) resumen.after(el); else document.getElementById("resultado-masivo").prepend(el);
    }
    return el;
  }
  function quitarBanner() { const el = document.getElementById("aviso-historico-gh"); if (el) el.remove(); }
  function pintarBanner(html, tipo) {
    const c = { info: ["#eef0f6", "#c7cce0", "#3c4a8a"], alerta: ["#fdf3ea", "#e8c39a", "#7a4a1f"], ok: ["#e8f4ec", "#bfe0cb", "#2f7a4f"], error: ["#fbe9ea", "#e6b3ba", "#a3283a"] }[tipo];
    const el = banner(); el.style.background = c[0]; el.style.borderColor = c[1]; el.style.color = c[2]; el.innerHTML = html;
  }

  async function revisarContraHistorico() {
    const filas = filasMasivas;
    const guardar = document.getElementById("btn-guardar-masivo"), estabaDeshabilitado = guardar.disabled;
    guardar.disabled = true;                                              // que no se guarde mientras se revisa
    pintarBanner("<strong>Validando contra el histórico de Gestión Humana…</strong> un momento.", "info");
    try {
      const cedulas = [...new Set(filas.map(r => soloDigitos(r.identificacion)).filter(Boolean))];
      const mapa = await leerHistorialPorCedulas(sb, cedulas);
      if (filasMasivas !== filas) return;                                 // mientras tanto cancelaron o subieron otro archivo
      historial = mapa;
      validarYMostrarMasivo();                                            // vuelve a dibujar la tabla, ahora con los avisos
      const dePropia = filas.filter(r => r._errores.some(e => e.startsWith("YA ESTÁ AFILIADO en esta misma unidad"))).length;
      const deOtra = filas.filter(r => r._errores.some(e => e.startsWith("YA ESTÁ AFILIADO por otra unidad"))).length;
      const total = dePropia + deOtra;
      if (total === 0) {
        pintarBanner(`<strong>Validación contra el histórico de Gestión Humana:</strong> ninguna de las ${cedulas.length} cédulas del archivo figura afiliada en fechas que se crucen con las de este archivo.`, "ok");
      } else {
        pintarBanner(`<strong>Validación contra el histórico de Gestión Humana:</strong> ${total} de ${filas.length} fila(s) <strong>YA ESTÁN AFILIADAS</strong> (${dePropia} en esta misma unidad, ${deOtra} por otra unidad). Mira la columna “Detalle de errores” para ver las fechas. Es solo un aviso: puedes guardarlas igual, pero revísalas antes de enviarlas a AXA.`, "alerta");
      }
    } catch (e) {
      historial = new Map();
      pintarBanner(`<strong>No se pudo consultar el histórico de Gestión Humana</strong> (${e.message}). Las filas se validaron sin ese control. ¿Ya corriste el script 16 en Supabase?`, "error");
    } finally { if (filasMasivas === filas) guardar.disabled = estabaDeshabilitado; }
  }
})(typeof window !== "undefined" ? window : globalThis);
