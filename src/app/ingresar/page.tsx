"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "enlace" | "clave";

function IngresarForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>("enlace");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const supabase = createClient();
    try {
      if (mode === "enlace") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}/auth/confirmar?volver=${encodeURIComponent(params.get("volver") ?? "/")}` },
        });
        if (error) throw error;
        setStatus({ kind: "ok", text: "Le enviamos un enlace de acceso. Revise su correo (también la carpeta de spam)." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(params.get("volver") ?? "/");
        router.refresh();
      }
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>BIM Normative Checker</h1>
        <p className="muted small" style={{ margin: 0 }}>
          Revisión de modelos IFC contra la normativa urbana chilena. El modelo se procesa en su navegador y no se sube salvo que guarde el
          proyecto.
        </p>
        <label>
          <span className="small muted">Correo electrónico</span>
          <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === "clave" && (
          <label>
            <span className="small muted">Contraseña</span>
            <input className="input" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Enviando…" : mode === "enlace" ? "Enviar enlace de acceso" : "Ingresar"}
        </button>
        <button type="button" className="btn" onClick={() => setMode(mode === "enlace" ? "clave" : "enlace")}>
          {mode === "enlace" ? "Ingresar con contraseña" : "Ingresar con enlace por correo"}
        </button>
        {status && <div className={`alert ${status.kind === "ok" ? "alert-ok" : "alert-danger"}`}>{status.text}</div>}
      </form>
    </main>
  );
}

export default function IngresarPage() {
  // useSearchParams exige un límite de Suspense para el prerender estático.
  return (
    <Suspense fallback={<main className="login" />}>
      <IngresarForm />
    </Suspense>
  );
}
