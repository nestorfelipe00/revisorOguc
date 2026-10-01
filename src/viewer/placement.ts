// Panel "Mover modelo": ajusta la georreferencia del IFC desde el visor (mover, subir/bajar, girar).
// El host aplica cada orden y devuelve el estado; la ciudad 3D se recarga con la cámara quieta sobre ella,
// así en pantalla lo que se mueve es el modelo.
import type { HostMessage, ViewerMessage } from "./protocol";

type PlacementState = Extract<HostMessage, { type: "placementState" }>;
type Send = (message: ViewerMessage) => void;

const STEPS = [0.01, 0.1, 1, 10];

export class PlacementPanel {
  private readonly box = document.createElement("div");
  private state: PlacementState | null = null;

  constructor(root: HTMLElement, private readonly send: Send) {
    this.box.className = "placement";
    this.box.hidden = true;
    root.append(this.box);
    window.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  get isOpen(): boolean {
    return !this.box.hidden;
  }

  open(): void {
    this.command("open");
  }

  setState(state: PlacementState): void {
    this.state = state;
    const open = state.open && state.mode === "fine";
    this.box.hidden = !open;
    if (open) this.render();
  }

  private command(command: string, argument?: string): void {
    this.send({ type: "placementCommand", command, argument: argument ?? null });
  }

  private render(): void {
    const s = this.state!;
    const button = (label: string, title: string, command: string, argument?: string, className = "") => {
      const b = document.createElement("button");
      b.className = `small ${className}`;
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => this.command(command, argument));
      return b;
    };
    const row = (label: string, ...items: HTMLElement[]) => {
      const r = document.createElement("div");
      r.className = "placement-row";
      const l = document.createElement("span");
      l.className = "placement-label";
      l.textContent = label;
      r.append(l, ...items);
      return r;
    };
    const text = (content: string, className: string) => {
      const d = document.createElement("div");
      d.className = className;
      d.textContent = content;
      return d;
    };

    const steps = STEPS.map((value) =>
      button(value.toLocaleString("es-CL"), `Paso ${value.toLocaleString("es-CL")} m / °`, "step", String(value), value === s.step ? "selected" : ""),
    );
    const close = button("✕", "Cancelar y cerrar (Esc)", "cancel", undefined, "close");
    if (s.confirmRequired) {
      const note = text("Este IFC ya trae georreferencia (IfcMapConversion). Para moverlo se usará una georreferencia definida por usted, guardada en el proyecto; el archivo IFC no cambia.", "placement-hint");
      const actions = document.createElement("div");
      actions.className = "placement-actions";
      actions.append(button("Cancelar", "No mover el modelo", "cancel"), button("Continuar", "Mover con una georreferencia propia", "confirm", undefined, "primary"));
      this.box.replaceChildren(text("Ajuste fino", "placement-title"), close, note, actions);
      return;
    }

    this.box.replaceChildren(
      text("Ajuste fino", "placement-title"),
      close,
      text(s.center, "placement-value"),
      text(`Rotación ${s.rotation} · Cota ${s.elevation}`, "placement-value"),
      row("Paso (m / °)", ...steps),
      row("Mapa", button("↑ N", "Mover al norte (↑)", "move", "N"), button("↓ S", "Mover al sur (↓)", "move", "S"),
        button("→ E", "Mover al este (→)", "move", "E"), button("← O", "Mover al oeste (←)", "move", "O")),
      row("Modelo", button("+Y", "Según el eje Y del modelo (Mayús + ↑)", "move", "+Y"), button("−Y", "Contra el eje Y del modelo (Mayús + ↓)", "move", "-Y"),
        button("+X", "Según el eje X del modelo (Mayús + →)", "move", "+X"), button("−X", "Contra el eje X del modelo (Mayús + ←)", "move", "-X")),
      row("Altura", button("▲ Subir", "Subir el modelo (Re Pág)", "raise", "+"), button("▼ Bajar", "Bajar el modelo (Av Pág)", "raise", "-"),
        button("Apoyar en terreno", "Nivel 0 del modelo sobre el terreno", "ground")),
      row("Girar", button("↺ Antihorario", "Girar alrededor del centro del modelo (Q)", "rotate", "+"),
        button("↻ Horario", "Girar alrededor del centro del modelo (W)", "rotate", "-")),
      text("Teclado: flechas mueven en el mapa (con Mayús, en ejes del modelo) · Re Pág / Av Pág suben y bajan · Q / W giran · Enter acepta · Esc cancela.", "placement-hint"),
      ...(s.error ? [text(s.error, "placement-error")] : []),
      (() => {
        const actions = document.createElement("div");
        actions.className = "placement-actions";
        actions.append(
          button("Más opciones…", "Valores exactos, sistema de coordenadas, puntos conocidos y copia IFC georreferenciada", "more"),
          button("Deshacer", "Deshacer la última acción", "undo", undefined, s.canUndo ? "" : "disabled"),
          button("Cancelar", "Volver a la ubicación anterior", "cancel"),
          button("Aceptar", "Guardar esta ubicación en el proyecto", "accept", undefined, "primary"),
        );
        return actions;
      })(),
    );
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen || (e.target as HTMLElement).closest("input, textarea")) return;
    const moves: Record<string, [string, string]> = {
      ArrowUp: ["N", "+Y"],
      ArrowDown: ["S", "-Y"],
      ArrowRight: ["E", "+X"],
      ArrowLeft: ["O", "-X"],
    };
    let handled = true;
    if (e.key in moves) this.command("move", moves[e.key][e.shiftKey ? 1 : 0]);
    else if (e.key === "PageUp") this.command("raise", "+");
    else if (e.key === "PageDown") this.command("raise", "-");
    else if (e.key === "q" || e.key === "Q") this.command("rotate", "+");
    else if (e.key === "w" || e.key === "W") this.command("rotate", "-");
    else if (e.key === "Enter") this.command("accept");
    else if (e.key === "Escape") this.command("cancel");
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
}
