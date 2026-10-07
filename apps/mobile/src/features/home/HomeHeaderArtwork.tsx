import { HeaderHeightContext } from "@react-navigation/elements";
import { useContext } from "react";
import { Platform, View } from "react-native";

import { StageArtworkBackdrop } from "../../components/StageArtworkBackdrop";
import { useEnvironmentIdentification } from "../../components/useEnvironmentIdentification";

/** How far the art runs past the header. The list reserves it so its first row stays clear. */
export const HOME_ARTWORK_OVERHANG = 28;
const HOME_ARTWORK_FADE_LENGTH = HOME_ARTWORK_OVERHANG + 6;

/** The stage art behind the iPhone Home header, which is transparent under Liquid Glass. */
export function useHomeHeaderArtworkVariant() {
  const { artworkVariant } = useEnvironmentIdentification();
  return Platform.OS === "ios" ? artworkVariant : null;
}

export function HomeHeaderArtwork() {
  const variant = useHomeHeaderArtworkVariant();
  const headerHeight = useContext(HeaderHeightContext);
  if (!variant || !headerHeight) return null;

  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 top-0"
      style={{ height: headerHeight + HOME_ARTWORK_OVERHANG }}
    >
      <StageArtworkBackdrop
        variant={variant}
        fadeTo="--color-screen"
        fadeLength={HOME_ARTWORK_FADE_LENGTH}
      />
    </View>
  );
}
