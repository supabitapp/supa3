#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
mobile_dir=$(cd "$module_dir/../.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
react="$mobile_dir/ios/Pods/React-Core-prebuilt/React.xcframework/ios-arm64_x86_64-maccatalyst"
dependencies="$mobile_dir/ios/Pods/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/ios-arm64_x86_64-maccatalyst"
hermes="$mobile_dir/ios/Pods/hermes-engine/destroot/Library/Frameworks/universal/hermesvm.xcframework/ios-arm64_x86_64-maccatalyst"
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
header_args=()
for directory in "$mobile_dir"/ios/Pods/Headers/{Public,Private}/*; do
  header_args+=(-I "$directory")
done
# The prebuilt framework switches when Xcode builds Debug or Release. Match its
# C++ ABI while keeping assertions enabled in this test executable.
react_exports=$(xcrun nm -g "$react/React.framework/React")
if [[ "$react_exports" == *SealableC* ]]; then
  react_mode=-DREACT_NATIVE_DEBUG
else
  react_mode=-DREACT_NATIVE_PRODUCTION
fi
xcrun clang++ -O2 -std=c++20 -fobjc-arc -fblocks -DFOLLY_NO_CONFIG=1 -DFOLLY_CFG_NO_COROUTINES=1 \
  "$react_mode" \
  -target "$(uname -m)-apple-ios18.0-macabi" -isysroot "$sdk" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  -F "$react" -F "$dependencies" -F "$hermes" \
  -I "$react/React.framework/Headers" \
  -I "$mobile_dir/node_modules/react-native/ReactCommon" \
  -I "$mobile_dir/node_modules/react-native/ReactCommon/jsi" \
  -I "$mobile_dir/node_modules/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/ios" \
  -I "$mobile_dir/node_modules/react-native/ReactCommon/react/renderer/graphics/platform/ios" \
  -I "$dependencies/ReactNativeDependencies.framework/Headers" \
  -I "$mobile_dir/ios/Pods/ReactNativeDependencies/Headers" \
  -I "$mobile_dir/ios/build/generated/ios/ReactCodegen" -I "$module_dir/ios" \
  "${header_args[@]}" "$module_dir/tests/ios/main.mm" \
  -framework React -framework ReactNativeDependencies -framework hermesvm \
  -framework UIKit -framework Foundation \
  -Wl,-rpath,"$react" -Wl,-rpath,"$dependencies" -Wl,-rpath,"$hermes" \
  -o "$output/markdown-tests"
"$output/markdown-tests"
