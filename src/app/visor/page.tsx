import { createClient } from "@/lib/supabase/server";
import Workspace from "./Workspace";

export default async function VisorPage({ searchParams }: { searchParams: Promise<{ proyecto?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { proyecto } = await searchParams;
  const proyectoId = proyecto && /^[0-9a-f-]{36}$/i.test(proyecto) ? proyecto : null;
  return <Workspace userEmail={user?.email ?? ""} proyectoId={proyectoId} />;
}
