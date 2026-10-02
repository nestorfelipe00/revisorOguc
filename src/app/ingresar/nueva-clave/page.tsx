"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const MIN_PASSWORD = 12;

/** Destino del enlace «Olvidé mi contraseña»: /auth/confirmar ya abrió la sesión; aquí se fija la contraseña nueva. */
export default function NuevaClavePage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const supabase = createClient();
    try {
      if (password.length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      if (password !== repeat) throw new Error("Las contraseñas no coinciden.");
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("El enlace no es válido o ya expiró. Pida uno nuevo con «Olvidé mi contraseña».");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStatus({ kind: "ok", text: "Contraseña cambiada. Entrando…" });
      router.replace("/");
      router.refresh();
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>Cambiar contraseña</h1>
        <label>
          <span className="small muted">Contraseña nueva (mínimo {MIN_PASSWORD} caracteres)</span>
          <input
            className="input"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          <span className="small muted">Repita la contraseña nueva</span>
          <input
            className="input"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Guardando…" : "Guardar contraseña"}
        </button>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="btn small" onClick={() => router.push("/ingresar")}>
            Ir al ingreso
          </button>
        </div>
        {status && <div className={`alert ${status.kind === "ok" ? "alert-ok" : "alert-danger"}`}>{status.text}</div>}
      </form>
    </main>
  );
}
