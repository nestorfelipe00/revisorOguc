import { createClient } from "@/lib/supabase/server";
import Workspace from "./Workspace";

export default async function VisorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return <Workspace userEmail={user?.email ?? ""} />;
}
