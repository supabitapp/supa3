#pragma once

#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>
#include <unordered_map>

// Resolve each style once per conversion instead of once per fragment. The
// dictionaries are local to this call, including their mutable paragraph styles.
inline NSMutableAttributedString *SupacodeMarkdownTextConvertAttributedString(
    const facebook::react::AttributedString &attributedString) {
  using namespace facebook::react;
  std::unordered_map<TextAttributes, NSDictionary<NSAttributedStringKey, id> *> styles;
  NSMutableAttributedString *result = [NSMutableAttributedString new];
  [result beginEditing];
  for (const auto &fragment : attributedString.getFragments()) {
    // Let RN preserve attachment bounds and event-emitter attributes when present.
    if (fragment.isAttachment() || fragment.parentShadowView.componentHandle) {
      AttributedString single;
      auto copy = fragment;
      single.appendFragment(std::move(copy));
      [result appendAttributedString:RCTNSAttributedStringFromAttributedString(single)];
      continue;
    }
    auto it = styles.find(fragment.textAttributes);
    if (it == styles.end()) {
      it = styles.emplace(fragment.textAttributes,
          [RCTNSTextAttributesFromTextAttributes(fragment.textAttributes) copy]).first;
    }
    NSString *text = [[NSString alloc] initWithBytes:fragment.string.data()
        length:fragment.string.size() encoding:NSUTF8StringEncoding] ?: @"";
    if (fragment.textAttributes.textTransform.has_value()) {
      text = RCTNSStringFromStringApplyingTextTransform(text, fragment.textAttributes.textTransform.value());
    }
    [result appendAttributedString:[[NSAttributedString alloc] initWithString:text attributes:it->second]];
  }
  [result endEditing];
  return result;
}
