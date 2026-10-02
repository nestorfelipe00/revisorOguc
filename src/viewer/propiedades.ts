// Lectura de una propiedad por elemento desde Fragments (p. ej. FireRating para el adosamiento, R-04): se busca en los
// conjuntos de propiedades del elemento y, si no está, en los del tipo. Reemplaza a ProjectStore.FireRatings del escritorio.
import type * as FRAGS from "@thatopen/fragments";

const RELATIONS = {
  IsDefinedBy: { attributes: true, relations: true },
  HasProperties: { attributes: true, relations: false },
  HasPropertySets: { attributes: true, relations: true },
};

const VALUE_KEYS = ["NominalValue", "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue"];

function attribute(data: FRAGS.ItemData | undefined, name: string): unknown {
  const entry = data?.[name];
  return entry && !Array.isArray(entry) ? entry.value : undefined;
}

const isType = (item: FRAGS.ItemData) => /(TYPE|STYLE)$/.test(String(attribute(item, "_category") ?? ""));

function findProperty(sets: FRAGS.ItemData[], name: string): unknown {
  for (const set of sets) {
    const properties = set.HasProperties;
    if (!Array.isArray(properties)) continue;
    for (const property of properties) {
      if (String(attribute(property, "Name") ?? "") !== name) continue;
      for (const key of VALUE_KEYS) {
        const value = attribute(property, key);
        if (value !== undefined && value !== null) return value;
      }
    }
  }
  return undefined;
}

/** Valor (como texto) de la propiedad `name` para cada elemento que la tenga, por ExpressID. */
export async function propertyValues(model: FRAGS.FragmentsModel, expressIds: number[], name: string): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const batch = 400;
  for (let i = 0; i < expressIds.length; i += batch) {
    const ids = expressIds.slice(i, i + batch);
    const items = await model.getItemsData(ids, { attributesDefault: false, attributes: ["Name", "_category", "_localId"], relations: RELATIONS, relationsDefault: { attributes: false, relations: false } });
    items.forEach((data, index) => {
      const localId = Number(attribute(data, "_localId") ?? ids[index]);
      const definitions = Array.isArray(data?.IsDefinedBy) ? data.IsDefinedBy : [];
      let value = findProperty(definitions.filter((d) => !isType(d)), name);
      if (value === undefined) {
        const type = definitions.find(isType);
        value = findProperty(type && Array.isArray(type.HasPropertySets) ? type.HasPropertySets : [], name);
      }
      if (value !== undefined && value !== null && String(value).trim() !== "") result.set(localId, String(value));
    });
  }
  return result;
}
