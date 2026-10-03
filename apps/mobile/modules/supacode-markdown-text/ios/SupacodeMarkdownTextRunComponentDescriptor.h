#pragma once

#include "SupacodeMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using SupacodeMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<SupacodeMarkdownTextRunShadowNode>;

void SupacodeMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
