// =====================================================================
// APP: Afiliación ARL AXA Colpatria — Universidad del Rosario
// =====================================================================

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const REF = {}; // aquí se guardan en memoria las tablas de referencia ya cargadas
let modoLoginEsRegistro = false;
let filasMasivas = []; // resultado parseado del excel de cargue masivo

// ---------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------
function mostrarToast(mensaje, tipo = "info") {
  const el = document.getElementById("toast");
  el.textContent = mensaje;
  el.className = "toast " + (tipo === "error" ? "error" : tipo === "ok" ? "ok" : "");
  el.classList.remove("oculto");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.add("oculto"), 4500);
}

function mostrarModalRadicado(texto, titulo, mensaje) {
  document.getElementById("modal-radicado-texto").textContent = texto;
  document.querySelector("#modal-confirmacion h2").textContent = titulo || "Registro guardado";
  document.querySelector("#modal-confirmacion p").textContent = mensaje || "El estudiante quedó cargado correctamente. Este es su número de radicado:";
  document.getElementById("modal-confirmacion").classList.remove("oculto");
}
function cerrarModalRadicado() {
  document.getElementById("modal-confirmacion").classList.add("oculto");
}
document.getElementById("btn-cerrar-modal").addEventListener("click", cerrarModalRadicado);
document.getElementById("modal-confirmacion").addEventListener("click", (e) => {
  if (e.target.id === "modal-confirmacion") cerrarModalRadicado();
});
document.getElementById("btn-copiar-radicado").addEventListener("click", async () => {
  const texto = document.getElementById("modal-radicado-texto").textContent;
  await navigator.clipboard.writeText(texto);
  mostrarToast("Radicado copiado al portapapeles.", "ok");
});

function normalizarEncabezado(txt) {
  return String(txt || "")
    .toLowerCase()
    .replace(/obligatorio/g, "")
    .replace(/\n/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .replace(/[^a-z0-9/. ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Compara nombres de listas (EPS, facultad, ocupación, etc.) ignorando
// mayúsculas/minúsculas, puntos y espacios de más (ej. "SURA E.P.S." = "SURA E.P.S")
function normalizarTexto(txt) {
  return String(txt || "")
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function padStartZeros(valor, largo) {
  return String(valor ?? "").padStart(largo, "0").slice(-largo);
}
function padEndSpaces(valor, largo) {
  return String(valor ?? "").padEnd(largo, " ").slice(0, largo);
}
function formatoYYYYMMDD(fechaISO) {
  if (!fechaISO) return "";
  const [a, m, d] = fechaISO.split("-");
  return `${a}${m}${d}`;
}

// Fecha de afiliación y vigencia (Fecha Inicio de Cobertura) NO puede ser
// hoy ni una fecha anterior a hoy — debe aplicar mínimo un día después.
function coberturaEsValida(fechaCoberturaISO) {
  if (!fechaCoberturaISO) return null;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const cobertura = new Date(fechaCoberturaISO + "T00:00:00");
  return cobertura > hoy;
}

// Calcula la edad en años cumplidos a una fecha de referencia dada
// (por defecto, hoy). Para el tipo de identificación se usa la fecha de
// afiliación (Fecha Inicio de Cobertura); para el mínimo de 16 años se usa hoy.
function calcularEdad(fechaNacimientoISO, fechaReferenciaISO) {
  if (!fechaNacimientoISO) return null;
  const referencia = fechaReferenciaISO ? new Date(fechaReferenciaISO + "T00:00:00") : new Date();
  const nacimiento = new Date(fechaNacimientoISO + "T00:00:00");
  let edad = referencia.getFullYear() - nacimiento.getFullYear();
  const aunNoCumple = (referencia.getMonth() < nacimiento.getMonth()) ||
    (referencia.getMonth() === nacimiento.getMonth() && referencia.getDate() < nacimiento.getDate());
  if (aunNoCumple) edad--;
  return edad;
}

// Tipo de identificación esperado según la edad a la fecha de afiliación:
// 18 años o más -> Cédula. Menor de 18 -> Tarjeta Identidad.
function tipoIdentificacionEsperado(fechaNacimientoISO, fechaCoberturaISO) {
  const edad = calcularEdad(fechaNacimientoISO, fechaCoberturaISO);
  if (edad === null) return null;
  return edad >= 18 ? "Cédula" : "Tarjeta Identidad";
}

function celularEsValido(celular) {
  return /^[0-9]{10}$/.test(String(celular || "").trim());
}

function correoEsInstitucional(correo) {
  return /@UROSARIO\.EDU\.CO$/i.test(String(correo || "").trim());
}

// ---------------------------------------------------------------------
// AUTENTICACIÓN
// ---------------------------------------------------------------------
async function iniciar() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    mostrarApp(data.session);
  } else {
    document.getElementById("vista-login").classList.remove("oculto");
  }

  sb.auth.onAuthStateChange((evento, session) => {
    if (evento === "PASSWORD_RECOVERY") {
      document.getElementById("vista-login").classList.add("oculto");
      document.getElementById("vista-app").classList.add("oculto");
      document.getElementById("vista-nueva-clave").classList.remove("oculto");
      return;
    }
    if (session && document.getElementById("vista-nueva-clave").classList.contains("oculto")) {
      mostrarApp(session);
    }
  });
}

document.getElementById("link-olvide-clave").addEventListener("click", async () => {
  const correo = document.getElementById("login-correo").value.trim();
  if (!correo) {
    mostrarToast("Escribe primero tu correo arriba, y luego haz clic en '¿Olvidaste tu contraseña?'", "error");
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(correo, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) { mostrarToast("No se pudo enviar el correo: " + error.message, "error"); return; }
  mostrarToast("Te enviamos un correo con el link para elegir una nueva contraseña.", "ok");
});

document.getElementById("form-nueva-clave").addEventListener("submit", async (e) => {
  e.preventDefault();
  const clave1 = document.getElementById("nueva-clave-1").value;
  const clave2 = document.getElementById("nueva-clave-2").value;
  const errorBox = document.getElementById("nueva-clave-error");
  errorBox.classList.remove("visible");

  if (clave1 !== clave2) {
    errorBox.textContent = "Las dos contraseñas no coinciden.";
    errorBox.classList.add("visible");
    return;
  }
  const { error } = await sb.auth.updateUser({ password: clave1 });
  if (error) {
    errorBox.textContent = error.message;
    errorBox.classList.add("visible");
    return;
  }
  mostrarToast("Contraseña actualizada correctamente.", "ok");
  const { data } = await sb.auth.getSession();
  document.getElementById("vista-nueva-clave").classList.add("oculto");
  if (data.session) mostrarApp(data.session);
});

function mostrarApp(session) {
  document.getElementById("vista-login").classList.add("oculto");
  document.getElementById("vista-app").classList.remove("oculto");
  document.getElementById("usuario-correo").textContent = session.user.email;
  mostrarToast("Cargando datos de referencia (facultades, EPS, ocupaciones)…", "info");
  cargarReferencias().then(() => {
    construirFormularioManual();
    cargarRegistros();
    mostrarToast("Datos cargados. Ya puedes trabajar.", "ok");
  });
}

document.getElementById("link-modo").addEventListener("click", () => {
  modoLoginEsRegistro = !modoLoginEsRegistro;
  document.getElementById("btn-login").textContent = modoLoginEsRegistro ? "Crear cuenta" : "Ingresar";
  document.getElementById("texto-modo").textContent = modoLoginEsRegistro ? "¿Ya tienes cuenta?" : "¿No tienes cuenta?";
  document.getElementById("link-modo").textContent = modoLoginEsRegistro ? "Iniciar sesión" : "Crear una cuenta";
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const correo = document.getElementById("login-correo").value.trim();
  const clave = document.getElementById("login-clave").value;
  const errorBox = document.getElementById("login-error");
  errorBox.classList.remove("visible");

  const accion = modoLoginEsRegistro
    ? sb.auth.signUp({ email: correo, password: clave })
    : sb.auth.signInWithPassword({ email: correo, password: clave });

  const { data, error } = await accion;
  if (error) {
    errorBox.textContent = error.message;
    errorBox.classList.add("visible");
    return;
  }
  if (modoLoginEsRegistro && !data.session) {
    mostrarToast("Cuenta creada. Revisa tu correo si se requiere confirmación, luego inicia sesión.", "ok");
    modoLoginEsRegistro = false;
    document.getElementById("link-modo").click();
  }
});

document.getElementById("btn-salir").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// ---------------------------------------------------------------------
// CARGA DE TABLAS DE REFERENCIA
// ---------------------------------------------------------------------
async function cargarReferencias() {
  const tablas = [
    "ref_tipo_identificacion", "ref_sexo", "ref_estado_civil", "ref_tipo_salario",
    "ref_eps", "ref_codigo_riesgo", "ref_facultades", "ref_sucursales",
    "ref_ocupaciones", "ref_departamentos_ciudades"
  ];
  // Se piden todas al mismo tiempo (en paralelo) en vez de una por una,
  // para no multiplicar la latencia de red por cada tabla.
  const resultados = await Promise.all(
    tablas.map(t => sb.from(t).select("*").order("id"))
  );
  tablas.forEach((t, i) => {
    const { data, error } = resultados[i];
    if (error) { console.error(t, error); REF[t] = []; }
    else REF[t] = data;
  });
  // departamentos únicos
  REF.departamentos = [...new Set(REF.ref_departamentos_ciudades.map(r => r.departamento))].sort();
  poblarDatalists();
}

function ciudadesDe(departamento) {
  return REF.ref_departamentos_ciudades.filter(r => r.departamento === departamento);
}

// ---------------------------------------------------------------------
// NAVEGACIÓN ENTRE PESTAÑAS
// ---------------------------------------------------------------------
document.querySelectorAll("nav.tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach(b => b.classList.remove("activo"));
    btn.classList.add("activo");
    document.querySelectorAll(".tab-contenido").forEach(s => s.classList.add("oculto"));
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("oculto");
    if (btn.dataset.tab === "registros") cargarRegistros();
  });
});

// ---------------------------------------------------------------------
// FORMULARIO MANUAL — construcción dinámica según datos_campos.js
// ---------------------------------------------------------------------
function revisarAlertaCobertura() {
  const cobertura = document.getElementById("campo-fecha_inicio_cobertura")?.value;
  const wrap = document.querySelector('[data-clave="fecha_inicio_cobertura"]');
  const alerta = wrap?.querySelector(".alerta-caja");
  if (!alerta || !cobertura) { if (alerta) alerta.classList.remove("visible"); return; }
  const valida = coberturaEsValida(cobertura);
  alerta.classList.add("visible");
  if (valida) {
    alerta.style.background = "#e8f4ec"; alerta.style.borderColor = "#bfe0cb"; alerta.style.color = "#2f7a4f";
    alerta.textContent = "✓ OK — la fecha de afiliación y vigencia es válida.";
  } else {
    alerta.style.background = "#fbe9ea"; alerta.style.borderColor = "#e6b3ba"; alerta.style.color = "#a3283a";
    alerta.textContent = "✕ No es posible: la fecha de afiliación y vigencia no puede ser hoy ni una fecha anterior. Debe aplicar mínimo un día después de hoy.";
  }
}

function construirFormularioManual() {
  const grid = document.getElementById("grid-manual");
  if (!grid) return; // Cargue manual retirado temporalmente de la interfaz
  grid.innerHTML = "";

  CAMPOS_FORMULARIO.forEach(campo => {
    const wrap = document.createElement("div");
    wrap.className = "campo";
    wrap.dataset.clave = campo.clave;

    const label = document.createElement("label");
    label.innerHTML = `<span>${campo.etiqueta}</span>` + (!campo.obligatorio ? `<span class="opcional">opcional</span>` : "");
    wrap.appendChild(label);

    let control;

    if (campo.tipo === "select") {
      control = document.createElement("select");
      control.innerHTML = `<option value="">Seleccione…</option>` +
        REF[campo.ref].map(r => `<option value="${escapeAttr(r.nombre ?? r.codigo)}">${escapeAttr(r.nombre ?? r.codigo)}</option>`).join("");
    } else if (campo.tipo === "select-facultad") {
      control = document.createElement("select");
      control.innerHTML = `<option value="">Seleccione…</option>` +
        REF.ref_facultades.map(r => `<option value="${escapeAttr(r.facultad_ur)}">${escapeAttr(r.facultad_ur)}</option>`).join("");
      control.addEventListener("change", () => aplicarFacultadDerivada(control.value));
    } else if (campo.tipo === "select-departamento") {
      control = document.createElement("select");
      control.innerHTML = `<option value="">Seleccione…</option>` +
        REF.departamentos.map(d => `<option value="${escapeAttr(d)}">${escapeAttr(d)}</option>`).join("");
      control.addEventListener("change", () => llenarCiudades(control.value));
    } else if (campo.tipo === "select-ciudad") {
      control = document.createElement("select");
      control.id = "campo-ciudad";
      control.innerHTML = `<option value="">Seleccione un departamento primero…</option>`;
    } else if (campo.tipo === "fecha" || campo.tipo === "fecha-cobertura") {
      control = document.createElement("input");
      control.type = "date";
      if (campo.tipo === "fecha-cobertura" || campo.clave === "fecha_inicio_practica") {
        control.addEventListener("change", revisarAlertaCobertura);
      }
    } else if (campo.tipo === "numero") {
      control = document.createElement("input");
      control.type = "number";
    } else if (campo.tipo === "correo") {
      control = document.createElement("input");
      control.type = "email";
      control.maxLength = campo.maxLength;
    } else if (campo.tipo === "texto-largo") {
      control = document.createElement("textarea");
      control.rows = 2;
    } else if (campo.tipo === "autocompletar-ocupacion") {
      wrap.classList.add("autocomplete");
      control = document.createElement("input");
      control.type = "text";
      control.placeholder = "Buscar ocupación…";
      control.autocomplete = "off";
      const caja = document.createElement("div");
      caja.className = "resultados";
      wrap.appendChild(caja);
      control.addEventListener("input", () => {
        const q = control.value.trim().toLowerCase();
        wrap.dataset.codigoOcupacion = "";
        if (q.length < 2) { caja.classList.remove("visible"); return; }
        const resultados = REF.ref_ocupaciones.filter(o => o.nombre.toLowerCase().includes(q)).slice(0, 30);
        caja.innerHTML = resultados.map(o =>
          `<div data-nombre="${escapeAttr(o.nombre)}" data-codigo="${escapeAttr(o.codigo)}"><b>${escapeAttr(o.codigo)}</b> — ${escapeAttr(o.nombre)}</div>`
        ).join("") || `<div style="color:#8a837a">Sin resultados — puedes digitarla igual</div>`;
        caja.classList.add("visible");
      });
      caja.addEventListener("click", (ev) => {
        const fila = ev.target.closest("div[data-nombre]");
        if (!fila) return;
        control.value = fila.dataset.nombre;
        wrap.dataset.codigoOcupacion = fila.dataset.codigo;
        caja.classList.remove("visible");
      });
      document.addEventListener("click", (ev) => { if (!wrap.contains(ev.target)) caja.classList.remove("visible"); });
    } else if (campo.tipo === "derivado") {
      control = document.createElement("input");
      control.type = "text";
      control.readOnly = true;
      control.classList.add("readonly");
      control.placeholder = "Se completa al elegir la Facultad";
    } else {
      control = document.createElement("input");
      control.type = "text";
      if (campo.maxLength) control.maxLength = campo.maxLength;
      if (campo.minLength) control.minLength = campo.minLength;
    }

    control.id = "campo-" + campo.clave;
    control.name = campo.clave;
    if (campo.obligatorio && campo.tipo !== "derivado") control.required = true;
    wrap.appendChild(control);

    if (campo.ayuda) {
      const ayuda = document.createElement("div");
      ayuda.className = "ayuda";
      ayuda.textContent = campo.ayuda;
      wrap.appendChild(ayuda);
    }
    if (campo.tipo === "fecha-cobertura") {
      const alerta = document.createElement("div");
      alerta.className = "alerta-caja";
      alerta.textContent = "La Fecha Inicio de Cobertura debe ser mínimo 1 día después de la Fecha Inicio de Práctica (nunca el mismo día). Puedes continuar, pero verifica antes de reportarlo a AXA.";
      wrap.appendChild(alerta);
    }
    grid.appendChild(wrap);
  });

  // Campo NIT: siempre "0", no se muestra al usuario (regla de negocio fija)
}

function aplicarFacultadDerivada(facultadUr) {
  const fila = REF.ref_facultades.find(f => f.facultad_ur === facultadUr);
  document.getElementById("campo-facultad_axa").value = fila ? fila.facultad_axa : "";
  document.getElementById("campo-codigo_centro_trabajo").value = fila ? fila.codigo_centro_trabajo : "";
}

function llenarCiudades(departamento) {
  const sel = document.getElementById("campo-ciudad");
  const ciudades = ciudadesDe(departamento);
  sel.innerHTML = `<option value="">Seleccione…</option>` +
    ciudades.map(c => `<option value="${escapeAttr(c.ciudad)}">${escapeAttr(c.ciudad)}</option>`).join("");
}

function escapeAttr(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function leerFormularioManual() {
  const registro = { nit_empresa: "0", origen: "manual" };
  CAMPOS_FORMULARIO.forEach(campo => {
    if (campo.tipo === "derivado") return;
    const el = document.getElementById("campo-" + campo.clave);
    let valor = el.value.trim();
    if (["texto", "texto-largo", "correo"].includes(campo.tipo)) valor = valor.toUpperCase();
    registro[campo.clave] = valor === "" ? null : valor;
  });
  const facultad = REF.ref_facultades.find(f => f.facultad_ur === registro.facultad_ur);
  registro.facultad_axa = facultad ? facultad.facultad_axa : null;
  registro.codigo_axa = facultad ? facultad.codigo_axa : null;
  registro.codigo_centro_trabajo = facultad ? facultad.codigo_centro_trabajo : null;

  const wrapOcup = document.querySelector('[data-clave="ocupacion"]');
  const ocupacionDigitada = registro.ocupacion ? registro.ocupacion.toUpperCase() : null;
  delete registro.ocupacion;
  let ocup = REF.ref_ocupaciones.find(o =>
    normalizarTexto(o.nombre) === normalizarTexto(ocupacionDigitada) ||
    String(o.codigo) === String(ocupacionDigitada || "").replace(/^0+/, "")
  );
  registro.ocupacion_nombre = ocup ? ocup.nombre : ocupacionDigitada;
  registro.ocupacion_codigo = ocup ? ocup.codigo : (wrapOcup.dataset.codigoOcupacion || "0000");

  return registro;
}

document.getElementById("form-manual")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const registro = leerFormularioManual();

  const edad = calcularEdad(registro.fecha_nacimiento);
  if (edad !== null && edad < 16) {
    mostrarToast(`No se puede guardar: el estudiante tiene ${edad} años. Solo se aceptan solicitudes para mayores de 16 años.`, "error");
    return;
  }
  if (!celularEsValido(registro.celular)) {
    mostrarToast("El Celular debe tener exactamente 10 dígitos (ni más ni menos).", "error");
    return;
  }
  if (!correoEsInstitucional(registro.correo_ur)) {
    mostrarToast("El Correo UR debe terminar en @urosario.edu.co", "error");
    return;
  }
  const tipoIdEsperado = tipoIdentificacionEsperado(registro.fecha_nacimiento, registro.fecha_inicio_cobertura);
  if (tipoIdEsperado && normalizarTexto(registro.tipo_identificacion) !== normalizarTexto(tipoIdEsperado)) {
    mostrarToast(`El Tipo de identificación debe ser "${tipoIdEsperado}" según la edad del estudiante a la fecha de afiliación.`, "error");
    return;
  }

  const btn = document.getElementById("btn-guardar-manual");
  btn.disabled = true;
  const { data, error } = await sb.from("solicitudes_arl").insert(registro).select("radicado").single();
  btn.disabled = false;
  if (error) {
    mostrarToast("No se pudo guardar: " + error.message, "error");
    return;
  }
  mostrarModalRadicado(data.radicado);
  document.getElementById("form-manual").reset();
  document.getElementById("campo-facultad_axa").value = "";
  document.getElementById("campo-codigo_centro_trabajo").value = "";
});

document.getElementById("btn-limpiar-manual")?.addEventListener("click", () => {
  document.getElementById("form-manual").reset();
});

// ---------------------------------------------------------------------
// CARGUE MASIVO
// ---------------------------------------------------------------------
const inputArchivo = document.getElementById("input-archivo-masivo");
const zonaCarga = document.getElementById("zona-carga");
zonaCarga.addEventListener("click", () => inputArchivo.click());
["dragover", "dragleave", "drop"].forEach(evt => {
  zonaCarga.addEventListener(evt, (e) => {
    e.preventDefault();
    zonaCarga.classList.toggle("activo", evt === "dragover");
    if (evt === "drop" && e.dataTransfer.files.length) procesarArchivoMasivo(e.dataTransfer.files[0]);
  });
});
inputArchivo.addEventListener("change", () => {
  if (inputArchivo.files.length) procesarArchivoMasivo(inputArchivo.files[0]);
});

function excelFechaAISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  if (typeof valor === "number") {
    const fecha = XLSX.SSF.parse_date_code(valor);
    return `${fecha.y}-${String(fecha.m).padStart(2, "0")}-${String(fecha.d).padStart(2, "0")}`;
  }
  const posible = new Date(valor);
  return isNaN(posible) ? null : posible.toISOString().slice(0, 10);
}

async function procesarArchivoMasivo(archivo) {
  document.getElementById("btn-guardar-masivo").disabled = false;
  document.getElementById("btn-guardar-masivo").textContent = "Guardar filas válidas";
  const buffer = await archivo.arrayBuffer();
  // dense:true acelera mucho la lectura de hojas grandes o muy formateadas
  // (la plantilla oficial de AXA trae las validaciones aplicadas hasta la
  // fila 10.000, aunque solo se usen unas pocas). sheetRows limita cuántas
  // filas se procesan como máximo, para no perder tiempo en miles de filas
  // vacías que solo tienen formato.
  const libro = XLSX.read(buffer, { type: "array", cellDates: true, dense: true, sheetRows: 3000 });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "" });

  if (filas.length >= 2990) {
    mostrarToast("Este archivo tiene muchísimas filas. Si tenías más de ~3.000 estudiantes reales, avísame porque algunos podrían no haberse leído.", "error");
  }

  // Detecta cuál fila trae los encabezados reales (probando las primeras 10),
  // por si el archivo tiene un botón, título o fila en blanco antes de la tabla.
  let filaEncabezados = 0;
  let mejorConteo = -1;
  for (let f = 0; f < Math.min(10, filas.length); f++) {
    const conteo = filas[f].filter(c => ENCABEZADOS_PLANTILLA[normalizarEncabezado(c)]).length;
    if (conteo > mejorConteo) { mejorConteo = conteo; filaEncabezados = f; }
  }
  if (mejorConteo <= 0) {
    mostrarToast("No se reconoció ninguna columna de la plantilla en este archivo. Verifica que los encabezados (Tipo de identificación, Primer Nombre, etc.) estén en una fila normal de la hoja.", "error");
    return;
  }

  const encabezados = filas[filaEncabezados].map(normalizarEncabezado);
  const mapaColumnas = {};
  encabezados.forEach((enc, idx) => {
    const clave = ENCABEZADOS_PLANTILLA[enc];
    // Si el mismo nombre de columna aparece más de una vez (ej. "Celular" duplicado
    // como resto vacío de la plantilla), se respeta la PRIMERA que aparezca.
    if (clave && !(clave in mapaColumnas)) mapaColumnas[clave] = idx;
  });

  filasMasivas = [];
  for (let i = filaEncabezados + 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila.every(v => String(v).trim() === "")) continue;
    const registro = { origen: "masivo", nit_empresa: "0" };
    Object.entries(mapaColumnas).forEach(([clave, idx]) => {
      let valor = fila[idx];
      if (["fecha_nacimiento", "fecha_inicio_practica", "fecha_final_practica", "fecha_inicio_cobertura"].includes(clave)) {
        valor = excelFechaAISO(valor);
      } else if (typeof valor === "string") {
        valor = valor.trim().toUpperCase();
      }
      registro[clave] = valor === "" ? null : valor;
    });
    registro.nit_empresa = "0"; // el NIT siempre queda en 0, sin importar lo que traiga el Excel
    filasMasivas.push(registro);
  }

  validarYMostrarMasivo();
}

function validarFilaMasiva(registro) {
  const errores = [];
  const req = (v) => v !== null && v !== undefined && String(v).trim() !== "";

  CAMPOS_FORMULARIO.forEach(c => {
    if (!c.obligatorio) return;
    const clave = c.clave === "ocupacion" ? "ocupacion" : c.clave;
    if (["facultad_axa", "codigo_centro_trabajo"].includes(c.clave)) return; // derivados
    if (!req(registro[clave])) errores.push(`Falta ${c.etiqueta}`);
  });

  if (registro.direccion && registro.direccion.length > 60) errores.push("Dirección > 60 caracteres");
  if (registro.telefono && registro.telefono.length > 15) errores.push("Teléfono > 15 caracteres");
  if (registro.correo_ur && registro.correo_ur.length > 60) errores.push("Correo > 60 caracteres");

  if (registro.celular && !celularEsValido(registro.celular)) errores.push("Celular debe tener exactamente 10 dígitos");
  if (registro.correo_ur && !correoEsInstitucional(registro.correo_ur)) errores.push("Correo debe terminar en @urosario.edu.co");

  const edad = calcularEdad(registro.fecha_nacimiento);
  if (edad !== null && edad < 16) errores.push(`Menor de 16 años (tiene ${edad})`);

  const facultad = REF.ref_facultades.find(f => normalizarTexto(f.facultad_ur) === normalizarTexto(registro.facultad_ur));
  if (registro.facultad_ur && !facultad) errores.push("Facultad no reconocida");
  if (facultad) {
    registro.facultad_axa = facultad.facultad_axa;
    registro.codigo_axa = facultad.codigo_axa;
    registro.codigo_centro_trabajo = facultad.codigo_centro_trabajo;
  }

  if (registro.eps && !REF.ref_eps.find(e => normalizarTexto(e.nombre) === normalizarTexto(registro.eps))) errores.push("EPS no reconocida");
  if (registro.tipo_identificacion && !REF.ref_tipo_identificacion.find(t => normalizarTexto(t.nombre) === normalizarTexto(registro.tipo_identificacion))) errores.push("Tipo de identificación no reconocido");
  if (registro.genero && !REF.ref_sexo.find(g => normalizarTexto(g.nombre) === normalizarTexto(registro.genero))) errores.push("Género no reconocido");
  if (registro.codigo_alto_riesgo && !REF.ref_codigo_riesgo.find(r => normalizarTexto(r.nombre) === normalizarTexto(registro.codigo_alto_riesgo))) errores.push("Código alto riesgo no reconocido");
  if (registro.codigo_sucursal && !REF.ref_sucursales.find(s => String(s.codigo) === String(registro.codigo_sucursal) || normalizarTexto(s.nombre) === normalizarTexto(registro.codigo_sucursal))) errores.push("Código de sucursal no reconocido");

  const ocup = REF.ref_ocupaciones.find(o =>
    normalizarTexto(o.nombre) === normalizarTexto(registro.ocupacion) ||
    String(o.codigo) === String(registro.ocupacion).replace(/^0+/, "")
  );
  registro.ocupacion_nombre = ocup ? ocup.nombre : (registro.ocupacion || null);
  registro.ocupacion_codigo = ocup ? ocup.codigo : null;
  if (registro.ocupacion && !ocup) errores.push("Ocupación no coincide exactamente con el listado (revisar texto o código)");

  if (registro.fecha_inicio_cobertura && coberturaEsValida(registro.fecha_inicio_cobertura) === false) {
    errores.push("Fecha de afiliación y vigencia no puede ser hoy ni anterior; debe ser mínimo 1 día después de hoy (se permite, pero verificar)");
  }

  const tipoIdEsperado = tipoIdentificacionEsperado(registro.fecha_nacimiento, registro.fecha_inicio_cobertura);
  if (tipoIdEsperado && registro.tipo_identificacion &&
      normalizarTexto(registro.tipo_identificacion) !== normalizarTexto(tipoIdEsperado)) {
    errores.push(`Tipo de identificación debería ser "${tipoIdEsperado}" según la edad a la fecha de afiliación`);
  }

  return errores;
}

function poblarDatalists() {
  document.getElementById("lista-departamentos").innerHTML =
    REF.departamentos.map(d => `<option value="${escapeAttr(d)}">`).join("");
  document.getElementById("lista-ciudades").innerHTML =
    REF.ref_departamentos_ciudades.map(c => `<option value="${escapeAttr(c.ciudad)}">`).join("");
  document.getElementById("lista-ocupaciones").innerHTML =
    REF.ref_ocupaciones.map(o => `<option value="${escapeAttr(o.nombre)}">`).join("");
}

function construirFilaEdicion(idx) {
  const r = filasMasivas[idx];
  const campos = CAMPOS_FORMULARIO.filter(c => c.tipo !== "derivado");
  const controles = campos.map(c => {
    const clave = c.clave;
    const valor = clave === "ocupacion" ? (r.ocupacion ?? r.ocupacion_nombre ?? "") : (r[clave] ?? "");
    const idc = `edit-${idx}-${clave}`;
    let html;
    if (c.tipo === "select") {
      html = `<select id="${idc}"><option value="">—</option>${REF[c.ref].map(o =>
        `<option value="${escapeAttr(o.nombre)}" ${normalizarTexto(o.nombre) === normalizarTexto(valor) ? "selected" : ""}>${escapeAttr(o.nombre)}</option>`).join("")}</select>`;
    } else if (c.tipo === "select-facultad") {
      html = `<select id="${idc}"><option value="">—</option>${REF.ref_facultades.map(f =>
        `<option value="${escapeAttr(f.facultad_ur)}" ${normalizarTexto(f.facultad_ur) === normalizarTexto(valor) ? "selected" : ""}>${escapeAttr(f.facultad_ur)}</option>`).join("")}</select>`;
    } else if (c.tipo === "select-departamento") {
      html = `<input list="lista-departamentos" id="${idc}" value="${escapeAttr(valor)}" />`;
    } else if (c.tipo === "select-ciudad") {
      html = `<input list="lista-ciudades" id="${idc}" value="${escapeAttr(valor)}" />`;
    } else if (c.tipo === "autocompletar-ocupacion") {
      html = `<input list="lista-ocupaciones" id="${idc}" value="${escapeAttr(valor)}" />`;
    } else if (c.tipo === "fecha" || c.tipo === "fecha-cobertura") {
      html = `<input type="date" id="${idc}" value="${escapeAttr(valor)}" />`;
    } else if (c.tipo === "numero") {
      html = `<input type="number" id="${idc}" value="${escapeAttr(valor ?? "")}" />`;
    } else {
      html = `<input type="text" id="${idc}" value="${escapeAttr(valor)}" />`;
    }
    return `<div class="campo-edicion"><label>${c.etiqueta}</label>${html}</div>`;
  }).join("");

  return `<tr class="fila-edicion" data-fila-edicion="${idx}"><td colspan="10"><div class="grid-edicion">
      ${controles}
      <div class="acciones-edicion">
        <button type="button" class="secundario btn-cancelar-edicion" data-idx="${idx}">Cerrar sin guardar</button>
        <button type="button" class="primario btn-aplicar-edicion" data-idx="${idx}">Aplicar cambios</button>
      </div>
    </div></td></tr>`;
}

function aplicarEdicionFila(idx) {
  const campos = CAMPOS_FORMULARIO.filter(c => c.tipo !== "derivado");
  const r = filasMasivas[idx];
  campos.forEach(c => {
    const el = document.getElementById(`edit-${idx}-${c.clave}`);
    if (!el) return;
    let valor = el.value.trim();
    if (["texto", "texto-largo", "correo"].includes(c.tipo)) valor = valor.toUpperCase();
    r[c.clave] = valor === "" ? null : valor;
  });
  validarYMostrarMasivo();
  mostrarToast("Cambios aplicados a la fila. Revisa si ya quedó en OK.", "ok");
}

function validarYMostrarMasivo() {
  const cont = document.getElementById("resultado-masivo");
  cont.classList.remove("oculto");
  const tabla = document.getElementById("tabla-masivo");
  const alertaResumen = document.getElementById("alerta-resumen-masivo");

  let validas = 0, invalidas = 0;
  const filasHtml = filasMasivas.map((r, idx) => {
    const errores = validarFilaMasiva(r);
    r._errores = errores;
    const soloAlerta = errores.every(e => e.includes("se permite"));
    if (errores.length === 0 || soloAlerta) validas++; else invalidas++;
    const estadoBadge = errores.length === 0
      ? `<span class="badge ok">OK</span>`
      : soloAlerta
      ? `<span class="badge ok" title="${escapeAttr(errores.join('; '))}">Alerta</span>`
      : `<span class="badge err">${errores.length} error(es)</span>`;
    const detalleErrores = errores.length
      ? `<span style="color:${soloAlerta ? '#b4501f' : '#a3283a'}">${escapeAttr(errores.join(' · '))}</span>`
      : "";
    const fila = `<tr data-fila="${idx}" class="${errores.length && !soloAlerta ? 'fila-error' : ''}">
      <td>${idx + 1}</td><td class="celda-estado">${estadoBadge}</td><td class="celda-radicado">—</td>
      <td>${escapeAttr(r.primer_nombre)} ${escapeAttr(r.primer_apellido)}</td>
      <td>${escapeAttr(r.identificacion)}</td>
      <td>${escapeAttr(r.facultad_ur)}</td>
      <td>${escapeAttr(r.eps)}</td>
      <td>${escapeAttr(r.ocupacion ?? r.ocupacion_nombre)}</td>
      <td class="celda-detalle" style="white-space:normal;max-width:280px;font-size:12px">${detalleErrores}</td>
      <td><button type="button" class="btn-editar-fila" data-idx="${idx}">Editar</button></td>
    </tr>`;
    return fila;
  }).join("");

  tabla.innerHTML = `<thead><tr><th>#</th><th>Estado</th><th>Radicado</th><th>Nombre</th><th>Identificación</th><th>Facultad</th><th>EPS</th><th>Ocupación</th><th>Detalle de errores</th><th></th></tr></thead><tbody>${filasHtml}</tbody>`;

  document.getElementById("resumen-total").textContent = filasMasivas.length;
  document.getElementById("resumen-validas").textContent = validas;
  document.getElementById("resumen-invalidas").textContent = invalidas;

  if (invalidas > 0) {
    alertaResumen.className = "alerta-caja visible";
    alertaResumen.style.background = "#fbe9ea"; alertaResumen.style.borderColor = "#e6b3ba"; alertaResumen.style.color = "#a3283a";
    alertaResumen.innerHTML = `<strong>Hay ${invalidas} fila(s) con errores.</strong> Revisa la columna "Detalle de errores" y haz clic en <strong>Editar</strong> en cada fila marcada para corregirla aquí mismo, sin volver al Excel. Solo se guardarán las filas que queden en OK o Alerta.`;
  } else {
    alertaResumen.className = "alerta-caja visible";
    alertaResumen.style.background = "#e8f4ec"; alertaResumen.style.borderColor = "#bfe0cb"; alertaResumen.style.color = "#2f7a4f";
    alertaResumen.innerHTML = `<strong>Todas las filas están listas.</strong> Puedes guardar cuando quieras.`;
  }

  document.querySelectorAll(".btn-editar-fila").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.idx;
      const existente = document.querySelector(`tr[data-fila-edicion="${idx}"]`);
      if (existente) { existente.remove(); return; }
      document.querySelectorAll(".fila-edicion").forEach(f => f.remove());
      document.querySelector(`tr[data-fila="${idx}"]`).insertAdjacentHTML("afterend", construirFilaEdicion(idx));
    });
  });
  document.querySelectorAll(".btn-cancelar-edicion").forEach(btn => {
    btn.addEventListener("click", () => document.querySelector(`tr[data-fila-edicion="${btn.dataset.idx}"]`).remove());
  });
  document.querySelectorAll(".btn-aplicar-edicion").forEach(btn => {
    btn.addEventListener("click", () => aplicarEdicionFila(Number(btn.dataset.idx)));
  });
}

document.getElementById("btn-cancelar-masivo").addEventListener("click", () => {
  filasMasivas = [];
  document.getElementById("resultado-masivo").classList.add("oculto");
  inputArchivo.value = "";
});

document.getElementById("btn-guardar-masivo").addEventListener("click", async () => {
  const indicesValidos = [];
  const registros = [];
  filasMasivas.forEach((r, idx) => {
    if (r._errores.every(e => e.includes("se permite"))) {
      indicesValidos.push(idx);
      const copia = { ...r };
      delete copia._errores;
      delete copia.ocupacion;
      copia.nit_empresa = "0";
      registros.push(copia);
    }
  });
  if (registros.length === 0) { mostrarToast("No hay filas válidas para guardar.", "error"); return; }

  const { data: lote, error: errorLote } = await sb.rpc("generar_lote");
  if (errorLote) { mostrarToast("Error generando el lote: " + errorLote.message, "error"); return; }
  registros.forEach(r => { r.lote_id = lote; });

  const { data, error } = await sb.from("solicitudes_arl").insert(registros).select("radicado");
  if (error) { mostrarToast("Error al guardar: " + error.message, "error"); return; }

  data.forEach((fila, i) => {
    const idxOriginal = indicesValidos[i];
    const filaTr = document.querySelector(`#tabla-masivo tr[data-fila="${idxOriginal}"]`);
    if (!filaTr) return;
    filaTr.classList.remove("fila-error");
    filaTr.classList.add("fila-guardada");
    filaTr.querySelector(".celda-radicado").innerHTML = `<strong>${fila.radicado}</strong>`;
    filaTr.querySelector(".celda-estado").innerHTML = `<span class="badge exportado">Guardado</span>`;
    filaTr.querySelector(".celda-detalle").innerHTML = `<span style="color:#2f7a4f;font-weight:600">✓ Guardado correctamente</span>`;
    const btnEditar = filaTr.querySelector(".btn-editar-fila");
    if (btnEditar) { btnEditar.disabled = true; btnEditar.textContent = "Guardado"; }
    const filaEdicion = document.querySelector(`tr[data-fila-edicion="${idxOriginal}"]`);
    if (filaEdicion) filaEdicion.remove();
  });

  const rango = data.length === 1 ? data[0].radicado : `${data[0].radicado} — ${data[data.length - 1].radicado}`;
  mostrarModalRadicado(rango, "Cargue masivo completado",
    `Se guardaron ${data.length} registro(s) con el código de paquete ${lote}. Puedes seleccionarlos todos juntos en "Registros y exportación". Radicado(s) asignado(s):`);

  document.getElementById("btn-guardar-masivo").disabled = true;
  document.getElementById("btn-guardar-masivo").textContent = "Ya guardado";
  inputArchivo.value = "";
});

// ---------------------------------------------------------------------
// REGISTROS / EXPORTACIÓN
// ---------------------------------------------------------------------
let registrosActuales = [];

async function cargarRegistros() {
  const estado = document.getElementById("filtro-estado").value;
  let consulta = sb.from("solicitudes_arl").select("*").order("creado_en", { ascending: false });
  if (estado) consulta = consulta.eq("estado", estado);
  const { data, error } = await consulta;
  if (error) { mostrarToast("Error cargando registros: " + error.message, "error"); return; }
  registrosActuales = data;
  pintarTablaRegistros();
  actualizarUltimoCargue();
}

// Trazabilidad: muestra quién hizo el último registro cargado, con qué
// facultad, y en qué fecha y hora — independiente del filtro que se use.
async function actualizarUltimoCargue() {
  const caja = document.getElementById("ultimo-cargue");
  if (!caja) return;
  const { data, error } = await sb
    .from("solicitudes_arl")
    .select("creado_por_email, facultad_ur, creado_en, origen, lote_id")
    .order("creado_en", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) { caja.classList.remove("visible"); return; }
  const ultimo = data[0];
  const fechaHora = new Date(ultimo.creado_en).toLocaleString("es-CO", {
    dateStyle: "medium", timeStyle: "short",
  });
  caja.classList.add("visible");
  caja.innerHTML = `🕓 <strong>Último registro cargado:</strong> ${escapeAttr(ultimo.creado_por_email || "—")}
    &nbsp;·&nbsp; Facultad: <strong>${escapeAttr(ultimo.facultad_ur || "—")}</strong>
    &nbsp;·&nbsp; ${fechaHora}
    ${ultimo.origen === "masivo" ? `&nbsp;·&nbsp; Lote: ${escapeAttr(ultimo.lote_id || "—")}` : ""}`;
}

function pintarTablaRegistros() {
  const texto = document.getElementById("filtro-texto").value.trim().toLowerCase();
  const lote = document.getElementById("filtro-lote").value;
  const filtrados = registrosActuales.filter(r =>
    (!texto || `${r.radicado} ${r.primer_nombre} ${r.primer_apellido} ${r.identificacion}`.toLowerCase().includes(texto)) &&
    (!lote || r.lote_id === lote)
  );

  // Llena el desplegable de lotes con los que existan en los registros actuales
  const selectorLote = document.getElementById("filtro-lote");
  const loteSeleccionado = selectorLote.value;
  const lotes = [...new Set(registrosActuales.map(r => r.lote_id).filter(Boolean))].sort().reverse();
  selectorLote.innerHTML = `<option value="">Todos los lotes</option>` +
    lotes.map(l => `<option value="${escapeAttr(l)}" ${l === loteSeleccionado ? "selected" : ""}>${escapeAttr(l)} (${registrosActuales.filter(r => r.lote_id === l).length})</option>`).join("");

  const tabla = document.getElementById("tabla-registros");
  tabla.innerHTML = `<thead><tr>
    <th><input type="checkbox" id="marcar-todos" /></th>
    <th>Radicado</th><th>Lote</th><th>Nombre</th><th>Identificación</th><th>Facultad</th><th>Fecha cobertura</th><th>Estado</th><th>Origen</th><th>Cargado por</th>
  </tr></thead><tbody>${filtrados.map(r => `
    <tr>
      <td><input type="checkbox" class="marca-fila" value="${r.id}" /></td>
      <td><strong>${escapeAttr(r.radicado)}</strong></td>
      <td>${escapeAttr(r.lote_id || "—")}</td>
      <td>${escapeAttr(r.primer_nombre)} ${escapeAttr(r.segundo_nombre || "")} ${escapeAttr(r.primer_apellido)} ${escapeAttr(r.segundo_apellido || "")}</td>
      <td>${escapeAttr(r.identificacion)}</td>
      <td>${escapeAttr(r.facultad_ur)}</td>
      <td>${escapeAttr(r.fecha_inicio_cobertura)}</td>
      <td><span class="badge ${r.estado}">${r.estado}</span></td>
      <td>${r.origen}</td>
      <td>${escapeAttr(r.creado_por_email || "")}</td>
    </tr>`).join("")}</tbody>`;

  document.getElementById("marcar-todos").addEventListener("change", (e) => {
    document.querySelectorAll(".marca-fila").forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById("contador-seleccion").textContent =
    `${filtrados.length} registro(s) en esta vista` + (lote ? ` — filtrando por ${lote}` : "");
}

document.getElementById("btn-refrescar").addEventListener("click", cargarRegistros);
document.getElementById("filtro-estado").addEventListener("change", cargarRegistros);
document.getElementById("filtro-texto").addEventListener("input", pintarTablaRegistros);
document.getElementById("filtro-lote").addEventListener("change", () => {
  pintarTablaRegistros();
  // Al elegir un lote, selecciona automáticamente todas sus filas visibles
  document.querySelectorAll(".marca-fila").forEach(cb => cb.checked = !!document.getElementById("filtro-lote").value);
});

function registrosSeleccionados() {
  const ids = [...document.querySelectorAll(".marca-fila:checked")].map(cb => cb.value);
  return registrosActuales.filter(r => ids.includes(r.id));
}

// ---- Exportación .txt de ancho fijo para Colpatria (misma lógica que la macro original) ----
function construirLineaTxt(r) {
  const tipoId = REF.ref_tipo_identificacion.find(t => normalizarTexto(t.nombre) === normalizarTexto(r.tipo_identificacion));
  const sexo = REF.ref_sexo.find(s => normalizarTexto(s.nombre) === normalizarTexto(r.genero));
  const estadoCivil = r.estado_civil
    ? REF.ref_estado_civil.find(e => normalizarTexto(e.nombre) === normalizarTexto(r.estado_civil))
    : null;
  const tipoSalario = REF.ref_tipo_salario.find(t => normalizarTexto(t.nombre) === normalizarTexto(r.tipo_salario));
  const eps = REF.ref_eps.find(e => normalizarTexto(e.nombre) === normalizarTexto(r.eps));
  const riesgo = REF.ref_codigo_riesgo.find(x => normalizarTexto(x.nombre) === normalizarTexto(r.codigo_alto_riesgo));
  const ciudad = r.ciudad
    ? REF.ref_departamentos_ciudades.find(c => normalizarTexto(c.ciudad) === normalizarTexto(r.ciudad) && normalizarTexto(c.departamento) === normalizarTexto(r.departamento))
    : null;

  const partes = [
    tipoId ? tipoId.codigo : "",
    padStartZeros(r.identificacion, 11),
    padStartZeros("0", 11),                              // NIT empresa en misión (siempre 0)
    padEndSpaces(r.codigo_sucursal, 15),
    padEndSpaces(r.codigo_centro_trabajo, 15),
    padEndSpaces(r.primer_nombre, 15),
    padEndSpaces(r.segundo_nombre, 15),
    padEndSpaces(r.primer_apellido, 15),
    padEndSpaces(r.segundo_apellido, 15),
    formatoYYYYMMDD(r.fecha_nacimiento),
    sexo ? sexo.codigo : "",
    r.estado_civil ? (estadoCivil ? estadoCivil.codigo : "00") : "00",
    formatoYYYYMMDD(r.fecha_inicio_practica),
    formatoYYYYMMDD(r.fecha_final_practica),
    formatoYYYYMMDD(r.fecha_inicio_cobertura),
    r.codigo_axa || "",
    tipoSalario ? tipoSalario.codigo : "",
    padStartZeros(r.valor_salario, 11),
    padEndSpaces(r.cargo, 30),
    eps ? eps.codigo : "",
    "000",                                                 // AFP (no aplica a estudiantes)
    "",                                                     // Departamento (siempre vacío, igual que la macro original)
    ciudad ? padStartZeros(ciudad.codigo, 4) : "0000",
    padStartZeros(r.ocupacion_codigo, 4),
    padEndSpaces(r.direccion, 60),
    padEndSpaces(r.telefono, 15),
    padEndSpaces(r.celular, 15),
    padEndSpaces(r.correo_ur, 60),
    riesgo ? riesgo.codigo : "",
  ];
  return partes.join("");
}

// Construye el nombre de archivo: AAAAMMDD_CARGUE MASIVO FACULTAD <NOMBRE>.<ext>
// Si la selección tiene varias facultades distintas, se indica "VARIAS FACULTADES".
function nombreArchivoCargue(seleccion, extension) {
  const hoy = new Date();
  const fecha = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, "0")}${String(hoy.getDate()).padStart(2, "0")}`;
  const facultades = [...new Set(seleccion.map(r => r.facultad_ur).filter(Boolean))];
  const etiquetaFacultad = facultades.length === 1 ? facultades[0] : "VARIAS FACULTADES";
  const nombre = `${fecha}_CARGUE MASIVO FACULTAD ${etiquetaFacultad}`.replace(/[\\/:*?"<>|]/g, "-");
  return `${nombre}.${extension}`;
}

document.getElementById("btn-exportar-txt").addEventListener("click", async () => {
  const seleccion = registrosSeleccionados();
  if (seleccion.length === 0) { mostrarToast("Selecciona al menos un registro.", "error"); return; }
  const lineas = seleccion.map(construirLineaTxt);
  const contenido = lineas.join("\r\n").toUpperCase();
  descargarArchivoTxtLatin1(contenido, nombreArchivoCargue(seleccion, "txt"));

  const ids = seleccion.map(r => r.id);
  await sb.from("solicitudes_arl").update({ estado: "exportado" }).in("id", ids);
  cargarRegistros();
  mostrarToast(`Archivo .txt generado con ${seleccion.length} registro(s).`, "ok");
});

// ---- Exportación a la plantilla Excel (35 columnas, formato PLANTILLA original) ----
const ENCABEZADOS_SALIDA_XLSX = [
  "Tipo de identificación\nOBLIGATORIO", "Identificación empleado\n         OBLIGATORIO", "Primer Nombre\nOBLIGATORIO",
  "Segundo Nombre", "Primer Apellido\nOBLIGATORIO", "Segundo Apellido", "Fecha de Nacimiento\nOBLIGATORIO",
  "Genero\nOBLIGATORIO", "Estado Civil", "Fecha Inicio Práctica\nOBLIGATORIO", "Fecha Final Práctica\nOBLIGATORIO",
  "Fecha Inicio de Cobertura\nOBLIGATORIO", "Facultad\nOBLIGATORIO", "Tipo de Salario\nOBLIGATORIO",
  "Valor Salario\nOBLIGATORIO", "Cargo\nOBLIGATORIO", "EPS\nOBLIGATORIO", "Departamento", "Ciudad",
  "Ocupación\nOBLIGATORIO", "NIT de empresa en misión", "Código de sucursal\nOBLIGATORIO",
  "Código de centro de trabajo\nOBLIGATORIO\n", "Dirección\nOBLIGATORIO", "Teléfono", "Celular\nOBLIGATORIO",
  "Correo electrónico UR\nOBLIGATORIO", "Código alto riesgo\nOBLIGATORIO", "CENTRO DE COSTO CARGUE PAGO ARL\nOBLIGATORIO",
  "ORDEN INTERNA CARGUE PAGO ARL\nOBLIGATORIO", "NOMBRE CENTRO DE PRACTICA Y/O ACTIVIDAD QUE CONLLEVA A AFILIACIÓN\nOBLIGATORIO\n",
  "FECHA REPORTE A GH", "NOVEDAD", "GESTIÓN ", "CASO CONECTA",
];

document.getElementById("btn-exportar-xlsx").addEventListener("click", () => {
  const seleccion = registrosSeleccionados();
  if (seleccion.length === 0) { mostrarToast("Selecciona al menos un registro.", "error"); return; }

  const filas = seleccion.map(r => ([
    r.tipo_identificacion, Number(r.identificacion), r.primer_nombre, r.segundo_nombre, r.primer_apellido, r.segundo_apellido,
    r.fecha_nacimiento, r.genero, r.estado_civil, r.fecha_inicio_practica, r.fecha_final_practica, r.fecha_inicio_cobertura,
    r.facultad_ur, r.tipo_salario, Number(r.valor_salario), r.cargo, r.eps, r.departamento, r.ciudad,
    r.ocupacion_nombre, "0", r.codigo_sucursal, r.codigo_centro_trabajo, r.direccion, r.telefono, r.celular,
    r.correo_ur, r.codigo_alto_riesgo, r.centro_costo, r.orden_interna, r.nombre_centro_practica,
    r.fecha_reporte, "", "", "",
  ]));

  const hoja = XLSX.utils.aoa_to_sheet([ENCABEZADOS_SALIDA_XLSX, ...filas]);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "PLANTILLA");
  XLSX.writeFile(libro, nombreArchivoCargue(seleccion, "xlsx"));
});

function descargarArchivo(contenido, nombre, tipoMime) {
  const blob = new Blob([contenido], { type: tipoMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Descarga el .txt de Colpatria codificado en Latin-1 / Windows-1252 (1 byte
// por carácter), igual que lo hacía la macro de Excel. Si se descargara en
// UTF-8 normal, letras como Ñ o tildes ocupan 2 bytes y dañan el largo fijo
// de cada línea, causando el error "La longitud de la línea no coincide".
function descargarArchivoTxtLatin1(texto, nombre) {
  const bytes = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    bytes[i] = texto.charCodeAt(i) & 0xff;
  }
  const blob = new Blob([bytes], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
iniciar();
