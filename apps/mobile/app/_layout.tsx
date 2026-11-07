import { Slot } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth";
import { PlayerProvider } from "../src/playback/PlayerProvider";
import { ConsumerShell } from "../src/shell/ConsumerShell";
import { SignInScreen } from "../src/auth/SignInScreen";
import { Notice } from "../src/components/ui/primitives";
import { View } from "react-native";
import { colors } from "../src/theme/tokens";
import { PlaybackActionProvider } from "../src/hooks/usePlaybackAction";

function SessionLayout() {
  const auth = useAuth();
  if (auth.status === "loading") return <View style={{ flex: 1, padding: 24, justifyContent: "center", backgroundColor: colors.background }}><Notice loading title="Connecting to your music" /></View>;
  if (auth.status === "signed-out") return <SignInScreen />;
  return <PlayerProvider><PlaybackActionProvider><ConsumerShell><Slot /></ConsumerShell></PlaybackActionProvider></PlayerProvider>;
}

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><StatusBar style="light" /><AuthProvider><SessionLayout /></AuthProvider></SafeAreaProvider></GestureHandlerRootView>;
}
