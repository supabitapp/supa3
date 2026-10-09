export interface NativeLayoutMetrics {
  readonly width: number;
  readonly height: number;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly safeArea: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
}
