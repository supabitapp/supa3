#pragma once

#include <react/renderer/components/SupacodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/SupacodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char SupacodeMarkdownTextComponentName[];

struct SupacodeMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;

  bool operator==(const SupacodeMarkdownTextParagraphStyleRange &) const = default;
};

struct SupacodeMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;

  bool operator==(const SupacodeMarkdownTextAttachmentRange &) const = default;
};

inline Float SupacodeMarkdownTextAttachmentSize(const SupacodeMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float SupacodeMarkdownTextAttachmentBaselineOffset(
    const SupacodeMarkdownTextAttachmentRange &) {
  return -2;
}

class SupacodeMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<SupacodeMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<SupacodeMarkdownTextAttachmentRange> attachmentRanges;
  std::vector<std::pair<Tag, bool>> runIdentities;
};

class SupacodeMarkdownTextShadowNode final : public ConcreteViewShadowNode<
SupacodeMarkdownTextComponentName,
SupacodeMarkdownTextProps,
SupacodeMarkdownTextEventEmitter,
SupacodeMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  SupacodeMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<SupacodeMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<SupacodeMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
