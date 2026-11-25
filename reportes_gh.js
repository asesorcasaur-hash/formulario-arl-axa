// =====================================================================
// MÓDULO "REPORTES GESTIÓN HUMANA"
// Agrega, junto al botón "Actualizar" de "Registros y exportación", dos botones:
//   · Generar reporte GH  → lleva al histórico los registros EXPORTADOS que aún no están
//   · Descargar histórico → baja el histórico completo en la estructura de 24 columnas
// Archivo independiente: NO modifica app.js ni ninguna otra parte de la plataforma.
// =====================================================================
(function (root) {
  "use strict";

  const ZONA = "America/Bogota";
  const ENCABEZADOS = ["TIPO DE DOCUMENTO DE IDENTIFICACIÓN OBLIGATORIO", "NÚMERO DEL DOCUMENTO", "APELLIDO 1\nOBLIGATORIO", "APELLIDO 2", "NOMBRE 1\nOBLIGATORIO", "NOMBRE 2", "GÉNERO\nOBLIGATORIO", "FECHA DE NACIMIENTO\n(DD/MM/AAAA)\nOBLIGATORIO", "SELECCIONE LA EPS\n(OBLIGATORIO)", "TELÉFONO", "CORREO INSTITUCIONAL", "CÓDIGO DEL CENTRO DE TRABAJO\n(OBLIGATORIO)", "FECHA INICIO PRÁCTICA\n(DD/MM/AAAA)\nOBLIGATORIO", "FECHA FIN PRÁCTICA\n(DD/MM/AAAA)\nOBLIGATORIO", "CENTRO DE COSTO CARGUE PAGO ARL\nOBLIGATORIO", "FACULTAD Y/O AREA SOLICITANTE DE AFILIACION", "PERSONA QUE ENVIA LA SOLICITUD DE AFILIACION", "OBSERVACIÓN/\nCARGUE", "FECHA SOLICITUD", "FECHA CARGUE", "COSTO MENSUAL", "COSTO MENSUAL", "COSTO REDONDEO", "COSTO POR PERIODO DE PRACTICA"];

  // ---------------------------------------------------------------- utilidades puras
  function normalizar(t) {
    return String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  }
  function fechaBogota(valor) { return new Date(valor).toLocaleDateString("en-CA", { timeZone: ZONA }); }
  function horaBogota(valor) { return new Date(valor).toLocaleTimeString("es-CO", { timeZone: ZONA, hour: "numeric", minute: "2-digit" }); }
  function hoyBogota() { return fechaBogota(new Date()); }
  function fechaLegible(iso) { if (!iso) return ""; const [a, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${a}`; }
  function diasEntre(ini, fin) {
    const [a1, m1, d1] = ini.split("-").map(Number), [a2, m2, d2] = fin.split("-").map(Number);
    return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86400000);
  }
  function redondear(n, dec) { const f = 10 ** dec; return Math.round(n * f) / f; }
  function solo10(t) { return String(t ?? "").replace(/\D/g, "") || null; }

  function letraDocumento(nombre) {
    const n = normalizar(nombre);
    if (n.startsWith("CEDULA EXTRANJERIA")) return "E";
    if (n === "CEDULA" || n.startsWith("CEDULA DE CIUDADANIA")) return "C";
    if (n.startsWith("TARJETA")) return "T";
    if (n.includes("SALVO")) return "S";
    return null; // Carné diplomático, permisos, etc.: la plantilla no define letra
  }
  function claveRegistro(doc, ini, fin) { return `${String(doc).replace(/\D/g, "")}|${ini}|${fin}`; }

  // ---------------------------------------------------------------- una solicitud -> una fila del histórico
  // ctx = { homologacion: Map(eps normalizada -> código), centros: Map("102" -> {centro_reporte, tasa}), ibc: Map(año -> valor) }
  function transformar(sol, ctx) {
    const tipo = letraDocumento(sol.tipo_identificacion);
    if (!tipo) return { error: `Tipo de documento sin letra definida (${sol.tipo_identificacion})` };
    const genero = normalizar(sol.genero).charAt(0);
    if (genero !== "F" && genero !== "M") return { error: `Género no reconocido (${sol.genero})` };
    const eps = ctx.homologacion.get(normalizar(sol.eps));
    if (!eps) return { error: `EPS sin homologación (${sol.eps})` };
    const centro = ctx.centros.get(String(sol.codigo_centro_trabajo));
    if (!centro) return { error: `Centro de trabajo ${sol.codigo_centro_trabajo} sin equivalencia en el reporte` };
    const anio = Number(String(sol.fecha_inicio_practica).slice(0, 4));
    const ibc = ctx.ibc.get(anio);
    if (!ibc) return { error: `Falta la base de cotización (IBC) del año ${anio}` };
    if (!sol.fecha_inicio_practica || !sol.fecha_final_practica) return { error: "Faltan fechas de la práctica" };

    const fechaCargue = fechaBogota(sol.actualizado_en);
    const tasa = Number(centro.tasa);
    const costoMensual = redondear(ibc * tasa, 4);
    const costoRedondeo = Math.ceil(costoMensual / 100) * 100;
    const costoPeriodo = redondear(diasEntre(sol.fecha_inicio_practica, sol.fecha_final_practica) / 30 * costoMensual, 5);
    return {
      fila: {
        solicitud_id: sol.id, origen: "plataforma",
        tipo_documento: tipo, numero_documento: String(sol.identificacion).replace(/\D/g, ""),
        apellido_1: sol.primer_apellido || null, apellido_2: sol.segundo_apellido || null,
        nombre_1: sol.primer_nombre || null, nombre_2: sol.segundo_nombre || null,
        genero, fecha_nacimiento: sol.fecha_nacimiento || null, eps,
        telefono: solo10(sol.celular), correo_institucional: String(sol.correo_ur || "").trim().toLowerCase() || null,
        codigo_centro_trabajo: Number(centro.centro_reporte),
        fecha_inicio_practica: sol.fecha_inicio_practica, fecha_fin_practica: sol.fecha_final_practica,
        centro_costo: sol.centro_costo || null, facultad: sol.facultad_ur || null,
        persona_envia: sol.creado_por_email || null,
        observacion_cargue: `${fechaCargue.replace(/-/g, "")}_CARGUE MASIVO FACULTAD ${sol.facultad_ur}`,
        fecha_solicitud: sol.fecha_reporte || fechaBogota(sol.creado_en), fecha_cargue: fechaCargue,
        costo_mensual_tasa: tasa, costo_mensual: costoMensual, costo_redondeo: costoRedondeo, costo_periodo: costoPeriodo,
      },
    };
  }

  // ---------------------------------------------------------------- qué falta por llevar al histórico
  function planificar({ solicitudes, idsIncorporados, clavesHistorico, ctx, hoy }) {
    const aIncorporar = [], noIncorporables = [], enHistorico = new Set(clavesHistorico), enLote = new Set();
    let yaEstaban = 0, repetidosEnLote = 0;
    for (const sol of solicitudes) {
      if (idsIncorporados.has(sol.id)) continue;
      const clave = claveRegistro(sol.identificacion, sol.fecha_inicio_practica, sol.fecha_final_practica);
      if (enHistorico.has(clave)) { yaEstaban++; continue; }      // misma cédula + inicio + fin: ya está en el histórico
      if (enLote.has(clave)) { repetidosEnLote++; continue; }     // aparece dos veces entre los pendientes
      const r = transformar(sol, ctx);
      if (r.error) { noIncorporables.push({ radicado: sol.radicado, motivo: r.error }); continue; }
      enLote.add(clave); aIncorporar.push(r.fila);
    }
    const deHoy = aIncorporar.filter(f => f.fecha_cargue === hoy).length;
    const fechas = aIncorporar.map(f => f.fecha_cargue).sort();
    return { aIncorporar, noIncorporables, yaEstaban, repetidosEnLote, deHoy, deAnteriores: aIncorporar.length - deHoy, desde: fechas[0] || null };
  }

  // ---------------------------------------------------------------- lectura paginada (Supabase entrega máx. 1.000 por consulta)
  async function leerTodo(consulta) {
    const out = [], paso = 1000;
    for (let desde = 0; ; desde += paso) {
      const { data, error } = await consulta(desde, desde + paso - 1);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < paso) break;
    }
    return out;
  }
  const COLS_SOL = "id, radicado, estado, actualizado_en, creado_en, fecha_reporte, creado_por_email, tipo_identificacion, identificacion, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, genero, fecha_nacimiento, eps, celular, correo_ur, codigo_centro_trabajo, fecha_inicio_practica, fecha_final_practica, centro_costo, facultad_ur";

  async function leerContexto(sb) {
    const [par, cen, ibc, hom] = await Promise.all([
      sb.from("reporte_gh_parametros").select("clave, valor"),
      sb.from("reporte_gh_centros").select("*"),
      sb.from("reporte_gh_ibc").select("*"),
      sb.from("reporte_gh_homologacion_eps").select("*"),
    ]);
    for (const r of [par, cen, ibc, hom]) if (r.error) throw new Error(r.error.message);
    const parametros = Object.fromEntries(par.data.map(p => [p.clave, p.valor]));
    return {
      fechaCorte: parametros.fecha_corte,
      ctx: {
        homologacion: new Map(hom.data.map(h => [normalizar(h.eps), h.codigo])),
        centros: new Map(cen.data.map(c => [String(c.centro_plataforma), c])),
        ibc: new Map(ibc.data.map(i => [Number(i.anio), Number(i.valor)])),
      },
    };
  }

  // ---------------------------------------------------------------- flujo completo "Generar reporte"
  // opciones.confirmar(resumen) -> Promise<boolean>   (la ventana de confirmación; en las pruebas es un simulador)
  async function ejecutarReporte(sb, opciones) {
    const hoy = opciones.hoy || hoyBogota();
    const { fechaCorte, ctx } = await leerContexto(sb);
    if (!fechaCorte) throw new Error("Falta el parámetro fecha_corte en reporte_gh_parametros");

    const solicitudes = await leerTodo((a, b) => sb.from("solicitudes_arl").select(COLS_SOL)
      .eq("estado", "exportado").gte("actualizado_en", `${fechaCorte}T00:00:00-05:00`)
      .order("actualizado_en", { ascending: true }).order("id", { ascending: true }).range(a, b));
    const historico = await leerTodo((a, b) => sb.from("reporte_gh_historico")
      .select("solicitud_id, numero_documento, fecha_inicio_practica, fecha_fin_practica").order("id", { ascending: true }).range(a, b));

    const plan = planificar({
      solicitudes, ctx, hoy,
      idsIncorporados: new Set(historico.map(h => h.solicitud_id).filter(Boolean)),
      clavesHistorico: historico.map(h => claveRegistro(h.numero_documento, h.fecha_inicio_practica, h.fecha_fin_practica)),
    });
    const base = { plan, fechaCorte, hoy, totalHistorico: historico.length };

    if (plan.aIncorporar.length === 0) {
      const { data: ult } = await sb.from("reporte_gh_ejecuciones").select("*").order("creado_en", { ascending: false }).limit(1);
      const ultima = ult && ult[0] ? ult[0] : null;
      const hizoHoy = ultima && fechaBogota(ultima.creado_en) === hoy;
      return { ...base, estado: hizoHoy ? "ya_hecho" : "sin_novedades", ultima };
    }

    const confirmado = await opciones.confirmar({ ...base });
    if (!confirmado) return { ...base, estado: "cancelado" };

    const ejecucionId = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : require("crypto").randomUUID();
    let insertados = 0, error = null;
    try {
      for (let i = 0; i < plan.aIncorporar.length; i += 500) {
        const lote = plan.aIncorporar.slice(i, i + 500).map(f => ({ ...f, ejecucion_id: ejecucionId }));
        const { data, error: e } = await sb.from("reporte_gh_historico")
          .upsert(lote, { onConflict: "solicitud_id", ignoreDuplicates: true }).select("id");
        if (e) throw new Error(e.message);
        insertados += data.length;
      }
    } catch (e) { error = e; }

    if (insertados > 0) {
      const incorporadas = plan.aIncorporar.slice(0, insertados);
      const { error: e2 } = await sb.from("reporte_gh_ejecuciones").insert({
        id: ejecucionId, creado_por_email: opciones.usuarioEmail || null, fecha_reporte: hoy, cantidad: insertados,
        cantidad_hoy: incorporadas.filter(f => f.fecha_cargue === hoy).length,
        cantidad_anteriores: incorporadas.filter(f => f.fecha_cargue !== hoy).length,
        desde_fecha: plan.desde, no_incorporados: plan.noIncorporables.length,
      });
      if (e2 && !error) error = e2;
    }
    return { ...base, estado: error ? "error" : "ok", error: error ? error.message : null, insertados, totalHistorico: historico.length + insertados };
  }

  // ---------------------------------------------------------------- descarga del histórico (Excel con las 24 columnas)
  const FECHAS = new Set([7, 12, 13, 18, 19]);   // posiciones (0..23) de columnas de fecha
  function filaExcel(h) {
    const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
    return [h.tipo_documento, /^\d{1,15}$/.test(h.numero_documento) ? Number(h.numero_documento) : h.numero_documento,
      h.apellido_1, h.apellido_2, h.nombre_1, h.nombre_2, h.genero, h.fecha_nacimiento, h.eps, h.telefono, h.correo_institucional,
      num(h.codigo_centro_trabajo), h.fecha_inicio_practica, h.fecha_fin_practica, h.centro_costo, h.facultad, h.persona_envia,
      h.observacion_cargue, h.fecha_solicitud, h.fecha_cargue, num(h.costo_mensual_tasa), num(h.costo_mensual), num(h.costo_redondeo), num(h.costo_periodo)];
  }
  function serialExcel(iso) { const [a, m, d] = iso.slice(0, 10).split("-").map(Number); return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; }
  function construirHoja(XLSX, filas) {
    const hoja = XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...filas.map(filaExcel)]);
    filas.forEach((f, i) => FECHAS.forEach(c => {
      const v = filaExcel(f)[c]; if (!v) return;
      hoja[XLSX.utils.encode_cell({ r: i + 1, c })] = { t: "n", v: serialExcel(v), z: "dd/mm/yyyy" };
    }));
    hoja["!cols"] = ENCABEZADOS.map(() => ({ wch: 18 }));
    return hoja;
  }

  const api = { normalizar, letraDocumento, transformar, planificar, claveRegistro, leerTodo, ejecutarReporte, filaExcel, serialExcel, construirHoja, fechaBogota, hoyBogota, ENCABEZADOS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ReportesGH = api;

  // =================================================================== PARTE VISUAL (solo en el navegador)
  if (typeof document === "undefined") return;

  function modal(titulo, htmlCuerpo, botones) {
    return new Promise(resolve => {
      const fondo = document.createElement("div");
      fondo.className = "modal-fondo";
      fondo.innerHTML = `<div class="modal-caja" style="max-width:520px;text-align:left">
        <h2 style="text-align:center">${titulo}</h2><div style="font-size:14px;line-height:1.55;color:#1f1b18">${htmlCuerpo}</div>
        <div class="modal-acciones" style="margin-top:18px"></div></div>`;
      const zona = fondo.querySelector(".modal-acciones");
      botones.forEach(b => {
        const el = document.createElement("button");
        el.className = b.primario ? "primario" : "secundario"; el.textContent = b.texto;
        el.onclick = () => { fondo.remove(); resolve(b.valor); };
        zona.appendChild(el);
      });
      document.body.appendChild(fondo);
    });
  }
  const aviso = (titulo, html) => modal(titulo, html, [{ texto: "Aceptar", primario: true, valor: true }]);
  const lista = (items) => `<ul style="margin:8px 0 0 18px;padding:0">${items.map(i => `<li>${i}</li>`).join("")}</ul>`;
  const noIncorporablesHtml = (n) => n.length === 0 ? "" :
    `<p style="margin-top:12px;color:#a3283a"><strong>${n.length} registro(s) no se pueden llevar todavía</strong> (siguen pendientes):` +
    lista(n.slice(0, 6).map(x => `${x.radicado}: ${x.motivo}`)) + (n.length > 6 ? `<br>… y ${n.length - 6} más.` : "") + `</p>`;

  async function alPresionarGenerar(boton) {
    boton.disabled = true; const textoOriginal = boton.textContent; boton.textContent = "Revisando…";
    try {
      const { data: ses } = await sb.auth.getSession();
      const email = ses?.session?.user?.email || null;
      const r = await ejecutarReporte(sb, {
        usuarioEmail: email,
        confirmar: ({ plan, hoy }) => modal("Generar reporte GH", `
          <p>Hay <strong>${plan.aIncorporar.length} registro(s) exportados</strong> que todavía no están en el histórico:</p>
          ${lista([`<strong>${plan.deHoy}</strong> exportados hoy`, `<strong>${plan.deAnteriores}</strong> exportados en días anteriores${plan.deAnteriores ? ` (desde el ${fechaLegible(plan.desde)})` : ""}`])}
          ${(plan.yaEstaban + plan.repetidosEnLote) ? `<p style="margin-top:10px;color:#5c5650">${plan.yaEstaban + plan.repetidosEnLote} más son repetidos (misma cédula y mismas fechas: ya estaban en el histórico o aparecen dos veces) y no se vuelven a llevar.</p>` : ""}
          ${noIncorporablesHtml(plan.noIncorporables)}
          <p style="margin-top:12px">¿Los llevo al histórico?</p>`,
          [{ texto: "Cancelar", valor: false }, { texto: "Sí, generar reporte", primario: true, valor: true }]),
      });
      if (r.estado === "ok") {
        await aviso("Reporte generado", `<p>Se llevaron <strong>${r.insertados} registro(s)</strong> al histórico (${r.plan.deHoy} de hoy y ${r.plan.deAnteriores} de días anteriores).</p>
          <p>El histórico ahora tiene <strong>${r.totalHistorico}</strong> registros. Ya lo puedes descargar con “Descargar histórico”.</p>${noIncorporablesHtml(r.plan.noIncorporables)}`);
      } else if (r.estado === "ya_hecho") {
        await aviso("El reporte de hoy ya se hizo", `<p>Se generó hoy a las <strong>${horaBogota(r.ultima.creado_en)}</strong> por <strong>${r.ultima.creado_por_email || "—"}</strong>, con <strong>${r.ultima.cantidad} registro(s)</strong>.</p>
          <p>No hay registros exportados nuevos desde entonces.</p>${noIncorporablesHtml(r.plan.noIncorporables)}`);
      } else if (r.estado === "sin_novedades") {
        await aviso("No hay nada por llevar", `<p>No hay registros exportados nuevos que falten en el histórico (se revisan los exportados desde el ${fechaLegible(r.fechaCorte)}).</p>
          ${r.ultima ? `<p>El último reporte fue el <strong>${fechaLegible(r.ultima.fecha_reporte)}</strong>, con ${r.ultima.cantidad} registro(s).</p>` : ""}${noIncorporablesHtml(r.plan.noIncorporables)}`);
      } else if (r.estado === "error") {
        await aviso("No se pudo terminar", `<p>${r.error}</p><p>${r.insertados} registro(s) alcanzaron a guardarse. Los demás siguen pendientes: vuelve a presionar “Generar reporte GH”.</p>`);
      }
    } catch (e) {
      await aviso("No se pudo generar el reporte", `<p>${e.message}</p><p>Si dice que no existe una tabla, falta correr el script <strong>16_reportes_gh_tablas.sql</strong> en Supabase.</p>`);
    } finally { boton.disabled = false; boton.textContent = textoOriginal; }
  }

  async function alPresionarDescargar(boton) {
    boton.disabled = true; const textoOriginal = boton.textContent; boton.textContent = "Preparando…";
    try {
      const filas = await leerTodo((a, b) => sb.from("reporte_gh_historico").select("*")
        .order("fecha_cargue", { ascending: true }).order("creado_en", { ascending: true }).order("id", { ascending: true }).range(a, b));
      if (filas.length === 0) { await aviso("El histórico está vacío", "<p>Todavía no hay registros. Primero importa el histórico inicial y luego genera el reporte.</p>"); return; }
      const libro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(libro, construirHoja(XLSX, filas), "REPORTE");
      XLSX.writeFile(libro, `HISTORICO_REPORTE_GH_${hoyBogota().replace(/-/g, "")}.xlsx`);
    } catch (e) { await aviso("No se pudo descargar", `<p>${e.message}</p>`); }
    finally { boton.disabled = false; boton.textContent = textoOriginal; }
  }

  function instalarBotones() {
    const actualizar = document.getElementById("btn-refrescar");
    if (!actualizar || document.getElementById("btn-generar-reporte-gh")) return;
    const generar = document.createElement("button");
    generar.id = "btn-generar-reporte-gh"; generar.className = "secundario"; generar.textContent = "Generar reporte GH";
    generar.title = "Lleva al histórico los registros exportados que aún no están";
    generar.onclick = () => alPresionarGenerar(generar);
    const descargar = document.createElement("button");
    descargar.id = "btn-descargar-historico-gh"; descargar.className = "secundario"; descargar.textContent = "Descargar histórico";
    descargar.onclick = () => alPresionarDescargar(descargar);
    actualizar.after(generar); generar.after(descargar);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", instalarBotones); else instalarBotones();
})(typeof window !== "undefined" ? window : globalThis);
