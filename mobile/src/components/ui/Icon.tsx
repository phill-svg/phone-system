import React from "react";
import { Platform } from "react-native";
import { SymbolView, type SymbolViewProps, type SymbolWeight } from "expo-symbols";
import { Ionicons } from "@expo/vector-icons";

// One icon API for the app. On iOS it renders real SF Symbols (native, crisp,
// weight-matched to text) via expo-symbols; elsewhere (web export, Android) it
// falls back to a matching Ionicon so nothing renders blank.
type IconProps = {
  name: SymbolViewProps["name"];
  fallback?: keyof typeof Ionicons.glyphMap;
  size?: number;
  color: string;
  weight?: SymbolWeight;
};

export function Icon({ name, fallback, size = 24, color, weight = "regular" }: IconProps) {
  if (Platform.OS === "ios") {
    return <SymbolView name={name} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" />;
  }
  return <Ionicons name={fallback ?? "ellipse-outline"} size={size} color={color} />;
}
