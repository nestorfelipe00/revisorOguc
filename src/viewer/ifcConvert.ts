import * as FRAGS from "@thatopen/fragments";

/** Convierte bytes IFC en fragments con los mismos ajustes que OBC.IfcLoader. */
export async function convertIfc(bytes: Uint8Array, wasmPath: string, onProgress: (progress: number) => void): Promise<Uint8Array> {
  const importer = new FRAGS.IfcImporter();
  importer.wasm = { path: wasmPath, absolute: true };
  // El modelo se lleva al origen y sus coordenadas originales se conservan en el fragments.
  importer.webIfcSettings = { COORDINATE_TO_ORIGIN: true };
  return importer.process({ bytes, progressCallback: (progress) => onProgress(progress) });
}
