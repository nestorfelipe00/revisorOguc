// Motor de reglas geométricas de la web (porte del escritorio): normas, predio, transformación, reglas R-01…R-11 y cabida.
export * from "./tipos";
export * from "./normas";
export * from "./predio";
export * from "./transformacion";
export { GeometricRuleEngine, evaluarReglas, fireMinutes, roundEven, F } from "./motor";
export { CabidaStudy, evaluarCabida } from "./cabida";
