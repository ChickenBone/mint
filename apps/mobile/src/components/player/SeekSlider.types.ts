export interface SeekSliderProps {
  duration: number;
  value: number;
  disabled?: boolean;
  onStart(value: number): void;
  onChange(value: number): void;
  onComplete(value: number): void;
}
