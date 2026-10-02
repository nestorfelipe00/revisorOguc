"use client";

// Banner «Comentarios»: ideas, problemas y preguntas de quien usa la aplicación, guardados en la tabla `comentarios`
// de Supabase (RLS: cada usuario inserta y ve solo los suyos). Vive al pie del panel IFC.
import { useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export type TipoComentario = "idea" | "problema" | "pregunta" | "otro";

const TIPOS: { id: TipoComentario; label: string }[] = [
  { id: "idea", label: "Idea o mejora" },
  { id: "problema", label: "Algo no funciona" },
  { id: "pregunta", label: "Pregunta" },
  { id: "otro", label: "Otro" },
];

export const MAX_COMENTARIO = 2000;

interface Props {
  supabase: SupabaseClient;
  /** Proyecto abierto, si lo hay: ayuda a reproducir lo que el usuario cuenta. */
  proyectoId: string | null;
  /** Pestaña activa del panel derecho al enviar. */
  pestana: string;
}

/** Inserta un comentario; `usuario` lo pone la base con auth.uid(). Devuelve el mensaje de error, o null si se guardó. */
export async function enviarComentario(
  supabase: SupabaseClient,
  datos: { tipo: TipoComentario; mensaje: string; pagina: string; proyectoId: string | null; contexto: Record<string, unknown> },
): Promise<string | null> {
  const mensaje = datos.mensaje.trim();
  if (mensaje.length < 3) return "Escriba al menos tres caracteres.";
  if (mensaje.length > MAX_COMENTARIO) return `El comentario no puede superar ${MAX_COMENTARIO} caracteres.`;
  const { error } = await supabase.from("comentarios").insert({
    tipo: datos.tipo,
    mensaje,
    pagina: datos.pagina.slice(0, 80),
    proyecto_id: datos.proyectoId,
    contexto: datos.contexto,
  });
  return error ? `No se pudo enviar el comentario: ${error.message}` : null;
}

export default function Comentarios({ supabase, proyectoId, pestana }: Props) {
  const [open, setOpen] = useState(false);
  const [tipo, setTipo] = useState<TipoComentario>("idea");
  const [mensaje, setMensaje] = useState("");
  const [estado, setEstado] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setEstado(null);
    const contexto = {
      pestana,
      navegador: navigator.userAgent.slice(0, 200),
      ancho: window.innerWidth,
      alto: window.innerHeight,
      version: "web 0.1",
    };
    const error = await enviarComentario(supabase, { tipo, mensaje, pagina: window.location.pathname, proyectoId, contexto });
    setEnviando(false);
    if (error) {
      setEstado({ kind: "error", text: error });
      return;
    }
    setMensaje("");
    setEstado({ kind: "ok", text: "¡Gracias! Su comentario quedó guardado y nos ayuda a mejorar la aplicación." });
  };

  return (
    <section className="comentarios" aria-label="Comentarios">
      <button className="comentarios-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <strong>Comentarios</strong>
          <span className="muted small"> · ¿Una idea, un problema, una pregunta?</span>
        </span>
        <span className="chevron" aria-hidden="true">
          {open ? "▾" : "▴"}
        </span>
      </button>
      {open && (
        <form className="comentarios-body" onSubmit={(e) => void enviar(e)}>
          <select className="input" value={tipo} onChange={(e) => setTipo(e.target.value as TipoComentario)} aria-label="Tipo de comentario">
            {TIPOS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <textarea
            className="input"
            rows={3}
            maxLength={MAX_COMENTARIO}
            placeholder="Cuéntenos qué le gustaría mejorar o qué no funcionó. Se guarda con la pestaña y el proyecto abiertos."
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            aria-label="Comentario"
          />
          <div className="comentarios-pie">
            <span className="muted small">
              {mensaje.length}/{MAX_COMENTARIO}
            </span>
            <button className="btn btn-primary small" type="submit" disabled={enviando || mensaje.trim().length < 3}>
              {enviando ? "Enviando…" : "Enviar"}
            </button>
          </div>
          {estado && <div className={`alert alert-${estado.kind === "ok" ? "ok" : "danger"} small`}>{estado.text}</div>}
        </form>
      )}
    </section>
  );
}
