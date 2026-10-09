import { Platform } from "react-native";

export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED = Platform.OS === "ios" && Platform.isPad;
