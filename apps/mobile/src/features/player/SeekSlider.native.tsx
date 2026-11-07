import Slider from "@react-native-community/slider";
import { StyleSheet } from "react-native";
import { colors } from "../../theme/tokens";
import type { SeekSliderProps } from "./SeekSlider.types";

export function SeekSlider({ duration, value, disabled, onStart, onChange, onComplete }: SeekSliderProps) {
  return <Slider accessibilityLabel="Playback position"
    accessibilityValue={{ min: 0, max: Math.floor(duration), now: Math.floor(value), text: `${Math.floor(value)} seconds` }}
    minimumValue={0} maximumValue={Math.max(1, duration)} value={value} disabled={disabled}
    minimumTrackTintColor={colors.text} maximumTrackTintColor="#ffffff55" thumbTintColor={colors.text}
    onSlidingStart={onStart} onValueChange={onChange} onSlidingComplete={onComplete} style={s.slider} />;
}
const s = StyleSheet.create({ slider: { minHeight: 44, width: "100%" } });
