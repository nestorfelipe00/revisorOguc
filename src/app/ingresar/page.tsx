"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "google" | "enlace" | "clave" | "registro";

const MIN_PASSWORD = 12;

// El botón de Google se muestra solo cuando el proveedor está activado en Supabase (NEXT_PUBLIC_AUTH_GOOGLE=1):
// si no, Supabase responde «provider is not enabled» con un JSON crudo.
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_AUTH_GOOGLE === "1";

function IngresarForm() {
  const router = useRouter();
  const params = useSearchParams();
  const volver = params.get("volver") ?? "/";
  const [mode, setMode] = useState<Mode>(GOOGLE_ENABLED ? "google" : "clave");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(
    params.get("error") ? { kind: "error", text: "El enlace no es válido o ya expiró. Pida uno nuevo." } : null,
  );
  const [busy, setBusy] = useState(false);

  async function google() {
    setBusy(true);
    setStatus(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${location.origin}/auth/callback?volver=${encodeURIComponent(volver)}` },
    });
    if (error) {
      setStatus({ kind: "error", text: `Google: ${error.message}` });
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const supabase = createClient();
    try {
      if (mode === "enlace") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}/auth/confirmar?volver=${encodeURIComponent(volver)}` },
        });
        if (error) throw error;
        setStatus({ kind: "ok", text: "Le enviamos un enlace de acceso. Revise su correo, también la carpeta de spam. Si no tenía cuenta, el enlace la crea." });
      } else if (mode === "registro") {
        if (password.length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${location.origin}/auth/confirmar?volver=${encodeURIComponent(volver)}` },
        });
        if (error) throw error;
        if (data.session) {
          router.replace(volver);
          router.refresh();
        } else {
          setStatus({ kind: "ok", text: "Cuenta creada. Le enviamos un correo para confirmarla; después podrá ingresar con su contraseña." });
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(volver);
        router.refresh();
      }
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = mode === "clave" || mode === "registro";

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>BIM Normative Checker</h1>
        <p className="muted small" style={{ margin: 0 }}>
          Revisión de modelos IFC contra la normativa urbana chilena. El modelo se procesa en su navegador y no se sube salvo que guarde el
          proyecto.
        </p>

        {GOOGLE_ENABLED && (
          <>
            <button type="button" className="btn btn-primary" onClick={google} disabled={busy}>
              Continuar con Google
            </button>
            <div className="muted small" style={{ textAlign: "center" }}>
              o con su correo
            </div>
          </>
        )}

        <label>
          <span className="small muted">Correo electrónico</span>
          <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {needsPassword && (
          <label>
            <span className="small muted">Contraseña{mode === "registro" ? ` (mínimo ${MIN_PASSWORD} caracteres)` : ""}</span>
            <input
              className="input"
              type="password"
              required
              minLength={mode === "registro" ? MIN_PASSWORD : undefined}
              autoComplete={mode === "registro" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {mode === "google" ? (
          <div style={{ display: "grid", gap: 6 }}>
            <button type="button" className="btn" onClick={() => setMode("enlace")}>
              Recibir un enlace de acceso por correo
            </button>
            <button type="button" className="btn" onClick={() => setMode("clave")}>
              Ingresar con contraseña
            </button>
            <button type="button" className="btn" onClick={() => setMode("registro")}>
              Crear una cuenta con correo y contraseña
            </button>
          </div>
        ) : (
          <>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Enviando…" : mode === "enlace" ? "Enviar enlace de acceso" : mode === "registro" ? "Crear cuenta" : "Ingresar"}
            </button>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {mode !== "clave" && (
                <button type="button" className="btn small" onClick={() => setMode("clave")}>
                  Ya tengo contraseña
                </button>
              )}
              {mode !== "registro" && (
                <button type="button" className="btn small" onClick={() => setMode("registro")}>
                  Crear cuenta
                </button>
              )}
              {mode !== "enlace" && (
                <button type="button" className="btn small" onClick={() => setMode("enlace")}>
                  Enlace por correo
                </button>
              )}
              {GOOGLE_ENABLED && (
                <button type="button" className="btn small" onClick={() => setMode("google")}>
                  Volver
                </button>
              )}
            </div>
          </>
        )}
        {status && <div className={`alert ${status.kind === "ok" ? "alert-ok" : "alert-danger"}`}>{status.text}</div>}
      </form>
    </main>
  );
}

export default function IngresarPage() {
  // useSearchParams exige un límite de Suspense.
  return (
    <Suspense fallback={<main className="login" />}>
      <IngresarForm />
    </Suspense>
  );
}
