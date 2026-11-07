import type { SeekSliderProps } from "./SeekSlider.types";
import { useRef } from "react";
import { colors } from "../../theme/tokens";

const seekKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
export function SeekSlider({ duration, value, disabled, onStart, onChange, onComplete }: SeekSliderProps) {
  const interacting = useRef(false);
  const start = (value: number) => { interacting.current = true; onStart(value); };
  const complete = (value: number) => { interacting.current = false; onComplete(value); };
  return <input type="range" aria-label="Playback position" aria-valuemin={0} aria-valuemax={duration}
    aria-valuenow={Math.min(value, duration)} aria-valuetext={`${Math.floor(value)} seconds`}
    min={0} max={Math.max(1, duration)} step={0.1} value={Math.max(0, Math.min(value, Math.max(1, duration)))}
    disabled={disabled} onPointerDown={(event) => { event.stopPropagation(); start(Number(event.currentTarget.value)); }}
    onChange={(event) => onChange(Number(event.currentTarget.value))}
    onPointerUp={(event) => complete(Number(event.currentTarget.value))}
    onPointerCancel={(event) => complete(Number(event.currentTarget.value))}
    onKeyDown={(event) => { if (seekKeys.has(event.key)) start(Number(event.currentTarget.value)); }}
    onKeyUp={(event) => { if (seekKeys.has(event.key)) complete(Number(event.currentTarget.value)); }}
    onBlur={(event) => { if (interacting.current) complete(Number(event.currentTarget.value)); }}
    style={{ width: "100%", minHeight: 44, margin: 0, accentColor: colors.text, cursor: disabled ? "default" : "pointer" }} />;
}
