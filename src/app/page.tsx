import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: proyectos } = await supabase.from("proyectos").select("id, nombre, tramite, actualizado_en").order("actualizado_en", { ascending: false });

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          BIM Normative Checker
        </Link>
        <span className="spacer" />
        <span className="muted small">{user?.email}</span>
        <form action="/auth/salir" method="post">
          <button className="btn" type="submit">
            Salir
          </button>
        </form>
      </header>
      <main className="page">
        <h1>Revisión normativa de modelos IFC</h1>
        <div className="grid">
          <Link href="/visor" className="card" style={{ textDecoration: "none" }}>
            <strong>Abrir IFC</strong>
            <p className="muted small">Visor 3D, territorio (comuna, zona del PRC), predio y revisión normativa R-01…R-11. El archivo se procesa en su navegador (hasta 100 MB).</p>
          </Link>
          <div className="card">
            <strong>Proyectos guardados</strong>
            {!proyectos?.length && <p className="muted small">Aún no hay proyectos. En el visor, póngale nombre y pulse «Guardar proyecto».</p>}
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {proyectos?.map((p) => (
                <li key={p.id} className="small">
                  <Link href={`/visor?proyecto=${p.id}`}>{p.nombre}</Link> <span className="muted">{p.tramite ?? ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 24 }}>
          Los datos del PRC son referenciales: lo oficial es la Ordenanza Local vigente. Esta revisión no reemplaza la del arquitecto revisor ni la de la DOM.
        </p>
      </main>
    </>
  );
}
