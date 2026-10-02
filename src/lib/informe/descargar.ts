// Entrega del informe en el navegador: descarga de archivos (JSON, Excel, HTML) y PDF con el diálogo de impresión del
// propio navegador sobre el HTML del informe (sin librería de PDF ni servidor), como propone docs/PLAN_WEB.md §6.

/** Descarga un archivo generado en memoria con el nombre indicado. */
export function descargarArchivo(nombre: string, contenido: BlobPart, tipo: string): void {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // El objeto se libera después de que el navegador tomó el enlace.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Abre el diálogo de impresión con el HTML del informe (el usuario elige «Guardar como PDF»). El documento se carga
 * en un iframe oculto con `srcdoc`, sin scripts; se quita al cerrar el diálogo.
 */
export function imprimirHtml(html: string, titulo: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.title = titulo;
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.sandbox.add("allow-same-origin", "allow-modals");
  frame.srcdoc = html;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };
  frame.addEventListener("load", () => {
    const win = frame.contentWindow;
    if (!win) return cleanup();
    win.addEventListener("afterprint", () => window.setTimeout(cleanup, 500));
    win.focus();
    win.print();
    // Navegadores sin «afterprint» en iframes: se limpia igual más tarde.
    window.setTimeout(cleanup, 120_000);
  });
  document.body.append(frame);
}
