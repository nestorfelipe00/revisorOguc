import * as WEBIFC from "web-ifc";

// Fragments entrega las clases en mayúsculas ("IFCWALL"). Construimos el nombre
// canónico ("IfcWall") a partir de los esquemas que publica web-ifc.
const canonical = new Map<string, string>();
for (const schema of [WEBIFC.IFC2X3, WEBIFC.IFC4, WEBIFC.IFC4X3]) {
  for (const name of Object.keys(schema)) {
    if (name.startsWith("Ifc")) canonical.set(name.toUpperCase(), name);
  }
}

export function toIfcClassName(category: string): string {
  return canonical.get(category.toUpperCase()) ?? category;
}
