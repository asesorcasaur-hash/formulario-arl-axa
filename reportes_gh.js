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

  // ---------------------------------------------------------------- filtro de la descarga (mes, rango o todo)
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  function nombreMes(ym) { const [a, m] = ym.split("-"); const t = `${MESES[Number(m) - 1]} ${a}`; return t.charAt(0).toUpperCase() + t.slice(1); }
  function rangoDeMes(ym) {
    const [a, m] = ym.split("-").map(Number), ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    return { desde: `${ym}-01`, hasta: `${ym}-${String(ultimo).padStart(2, "0")}` };
  }
  function listaMeses(desdeYM, hastaYM) {            // del más reciente al más antiguo
    const out = []; let [a, m] = desdeYM.split("-").map(Number); const [fa, fm] = hastaYM.split("-").map(Number);
    while (a < fa || (a === fa && m <= fm)) { out.push(`${a}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; a++; } }
    return out.reverse();
  }
  function parseDMA(t) {                              // "29/06/2026" -> "2026-06-29" (null si no es una fecha real)
    const x = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(t || "").trim()); if (!x) return null;
    const d = +x[1], mo = +x[2], a = +x[3], f = new Date(Date.UTC(a, mo - 1, d));
    if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d) return null;
    return `${a}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const COLUMNA_FECHA = { cargue: "fecha_cargue", inicio: "fecha_inicio_practica" };
  const ETIQUETA_COLUMNA = { cargue: "por fecha de cargue", inicio: "por fecha de inicio de práctica" };
  // f = { tipo: "todo" | "mes" | "rango", columna: "cargue" | "inicio", mes?: "2026-11", desde?: "2026-11-01", hasta?: "2026-11-30" }
  function normalizarFiltro(f) {
    if (!f || f.tipo === "todo") return { tipo: "todo", etiqueta: "todo el histórico" };
    const columna = f.columna === "inicio" ? "inicio" : "cargue", base = { tipo: f.tipo, columna, campo: COLUMNA_FECHA[columna] };
    if (f.tipo === "mes") return { ...base, ...rangoDeMes(f.mes), mes: f.mes, etiqueta: `${nombreMes(f.mes)} (${ETIQUETA_COLUMNA[columna]})` };
    return { ...base, desde: f.desde, hasta: f.hasta, etiqueta: `del ${fechaLegible(f.desde)} al ${fechaLegible(f.hasta)} (${ETIQUETA_COLUMNA[columna]})` };
  }
  function nombreArchivo(f, hoy) {
    const sufijo = f.columna === "inicio" ? "_INICIO_PRACTICA" : "";
    if (f.tipo === "mes") return `REPORTE_GH_${f.mes}${sufijo}.xlsx`;
    if (f.tipo === "rango") return `REPORTE_GH_${f.desde.replace(/-/g, "")}_a_${f.hasta.replace(/-/g, "")}${sufijo}.xlsx`;
    return `HISTORICO_REPORTE_GH_${hoy.replace(/-/g, "")}.xlsx`;
  }
  async function leerHistorico(sb, f) {
    const orden = f.campo || "fecha_cargue";
    return leerTodo((a, b) => {
      let q = sb.from("reporte_gh_historico").select("*");
      if (f.tipo !== "todo") q = q.gte(f.campo, f.desde).lte(f.campo, f.hasta);
      return q.order(orden, { ascending: true }).order("creado_en", { ascending: true }).order("id", { ascending: true }).range(a, b);
    });
  }

  const api = { nombreMes, rangoDeMes, listaMeses, parseDMA, normalizarFiltro, nombreArchivo, leerHistorico, normalizar, letraDocumento, transformar, planificar, claveRegistro, leerTodo, ejecutarReporte, filaExcel, serialExcel, construirHoja, fechaBogota, hoyBogota, ENCABEZADOS };
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
    } finally { boton.disabled = false; boton.textContent = textoOriginal; actualizarEstado(); }
  }

  function pedirFiltroDescarga() {
    return new Promise(resolve => {
      const meses = listaMeses("2025-08", hoyBogota().slice(0, 7));
      const fondo = document.createElement("div"); fondo.className = "modal-fondo";
      fondo.innerHTML = `<div class="modal-caja" style="max-width:520px;text-align:left">
        <h2 style="text-align:center">Descargar histórico GH</h2>
        <p style="font-size:14px;line-height:1.5;margin:0 0 12px">Elige qué parte del histórico quieres bajar en Excel.</p>
        <div style="display:grid;gap:12px;font-size:14px">
          <label>¿Qué quieres descargar?<br><select id="rgh-periodo" style="width:100%"><option value="mes">Un mes</option><option value="rango">Un rango de fechas</option><option value="todo">Todo el histórico</option></select></label>
          <label id="rgh-fila-mes">Mes<br><select id="rgh-mes" style="width:100%">${meses.map(m => `<option value="${m}">${nombreMes(m)}</option>`).join("")}</select></label>
          <div id="rgh-fila-rango" style="display:none;grid-template-columns:1fr 1fr;gap:10px">
            <label>Desde (DD/MM/AAAA)<br><input id="rgh-desde" type="text" placeholder="01/11/2026" maxlength="10" style="width:100%"></label>
            <label>Hasta (DD/MM/AAAA)<br><input id="rgh-hasta" type="text" placeholder="30/11/2026" maxlength="10" style="width:100%"></label></div>
          <label id="rgh-fila-col">Las fechas se miden por<br><select id="rgh-col" style="width:100%"><option value="cargue">Fecha de cargue (cuándo se envió a AXA)</option><option value="inicio">Fecha de inicio de la práctica</option></select></label>
          <p id="rgh-error" style="color:#a3283a;margin:0;font-size:13px"></p></div>
        <div class="modal-acciones" style="margin-top:16px"><button class="secundario" id="rgh-cancelar">Cancelar</button><button class="primario" id="rgh-ok">Descargar Excel</button></div></div>`;
      const $ = (id) => fondo.querySelector("#" + id);
      const mostrar = () => {
        const p = $("rgh-periodo").value;
        $("rgh-fila-mes").style.display = p === "mes" ? "" : "none";
        $("rgh-fila-rango").style.display = p === "rango" ? "grid" : "none";
        $("rgh-fila-col").style.display = p === "todo" ? "none" : "";
        $("rgh-error").textContent = "";
      };
      $("rgh-periodo").onchange = mostrar;
      $("rgh-cancelar").onclick = () => { fondo.remove(); resolve(null); };
      $("rgh-ok").onclick = () => {
        const tipo = $("rgh-periodo").value, columna = $("rgh-col").value;
        if (tipo === "rango") {
          const desde = parseDMA($("rgh-desde").value), hasta = parseDMA($("rgh-hasta").value);
          if (!desde || !hasta) { $("rgh-error").textContent = "Escribe las dos fechas completas, con el formato DD/MM/AAAA (por ejemplo 01/11/2026)."; return; }
          if (desde > hasta) { $("rgh-error").textContent = "La fecha «Desde» no puede ser posterior a «Hasta»."; return; }
          fondo.remove(); resolve({ tipo, columna, desde, hasta }); return;
        }
        fondo.remove(); resolve(tipo === "mes" ? { tipo, columna, mes: $("rgh-mes").value } : { tipo: "todo" });
      };
      document.body.appendChild(fondo); mostrar();
    });
  }

  async function alPresionarDescargar(boton) {
    const eleccion = await pedirFiltroDescarga(); if (!eleccion) return;
    const f = normalizarFiltro(eleccion);
    boton.disabled = true; const textoOriginal = boton.textContent; boton.textContent = "Preparando…";
    try {
      const filas = await leerHistorico(sb, f);
      if (filas.length === 0) {
        await aviso("No hay registros en ese período", `<p>No encontré registros de <strong>${f.etiqueta}</strong>.</p>
          <p>Prueba con otro mes o rango, o con «Todo el histórico». Recuerda que los registros nuevos llegan al histórico cuando alguien presiona «Generar reporte GH».</p>`);
        return;
      }
      const libro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(libro, construirHoja(XLSX, filas), "REPORTE");
      XLSX.writeFile(libro, nombreArchivo(f, hoyBogota()));
      await aviso("Descarga lista", `<p>Se descargaron <strong>${filas.length.toLocaleString("es-CO")} registros</strong> de ${f.etiqueta}.</p>`);
    } catch (e) { await aviso("No se pudo descargar", `<p>${e.message}</p>`); }
    finally { boton.disabled = false; boton.textContent = textoOriginal; }
  }

  async function actualizarEstado() {
    const el = document.getElementById("reporte-gh-estado"); if (!el) return;
    try {
      const [ult, tot] = await Promise.all([
        sb.from("reporte_gh_ejecuciones").select("*").order("creado_en", { ascending: false }).limit(1),
        sb.from("reporte_gh_historico").select("id", { count: "exact", head: true }),
      ]);
      if (ult.error || tot.error) throw new Error((ult.error || tot.error).message);
      const total = Number(tot.count || 0).toLocaleString("es-CO");
      const u = ult.data && ult.data[0];
      el.innerHTML = u
        ? `<strong>Último reporte:</strong> ${fechaLegible(u.fecha_reporte)} a las ${horaBogota(u.creado_en)}, por ${u.creado_por_email || "—"} (${u.cantidad} registro${u.cantidad === 1 ? "" : "s"}). <strong>Histórico:</strong> ${total} registros.`
        : `<strong>Todavía no se ha generado ningún reporte</strong> desde la carga inicial. <strong>Histórico:</strong> ${total} registros.`;
    } catch (e) {
      el.innerHTML = `No se pudo consultar el estado del reporte. ¿Ya corriste el script <strong>16_reportes_gh_tablas.sql</strong> en Supabase?`;
    }
  }

  function instalarBotones() {
    const aviso = document.getElementById("reporte-gh-sin-modulo"); if (aviso) aviso.style.display = "none"; // el módulo sí cargó
    const pestana = document.querySelector('nav.tabs button[data-tab="registros"]');
    if (pestana && !pestana.dataset.rghListo) { pestana.dataset.rghListo = "1"; pestana.addEventListener("click", () => actualizarEstado()); }
    const actualizar = document.getElementById("btn-refrescar");
    if (!actualizar || document.getElementById("btn-generar-reporte-gh")) return;
    const generar = document.createElement("button");
    const dorado = "border-color:#c79a3b;color:#6f1526;font-weight:600;background:#fdf8ec";
    generar.id = "btn-generar-reporte-gh"; generar.className = "secundario"; generar.textContent = "Generar reporte GH"; generar.style.cssText = dorado;
    generar.title = "Lleva al histórico de Gestión Humana los registros ya exportados a AXA que todavía no están allí. Se hace al cierre del día";
    generar.onclick = () => alPresionarGenerar(generar);
    const descargar = document.createElement("button");
    descargar.id = "btn-descargar-historico-gh"; descargar.className = "secundario"; descargar.textContent = "Descargar histórico"; descargar.style.cssText = dorado;
    descargar.title = "Baja en Excel el histórico del reporte para el pago de la ARL (24 columnas, con costos). Al presionarlo eliges el mes, un rango de fechas o todo el histórico";
    descargar.onclick = () => alPresionarDescargar(descargar);
    actualizar.after(generar); generar.after(descargar);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", instalarBotones); else instalarBotones();
})(typeof window !== "undefined" ? window : globalThis);
